import { expect } from "chai";
import { network } from "hardhat";
import { contractsInfo } from "../../helpers/constants";
import {
  loadValidatorRegistration,
  registerValidators,
  registrationFromIgnition,
  registrationFromLegacy,
  registrationFromParameters,
  type ValidatorRegistration,
} from "../../scripts/maintenance/helpers/validatorRegistration";

const { ethers, networkHelpers } = await network.create({
  network: "default",
  override: { chainId: 2401 },
});
const uvAddress = "0x0000000000000000000000000000000000001001";
const authAddress = "0x0000000000000000000000000000000000001002";
const requestAddress = "0x0000000000000000000000000000000000001003";
const ignoredLog = () => {};

// Keep the fixture independent of State/Poseidon and of the deployment scripts.
async function fixture() {
  const [owner, observer] = await ethers.getSigners();
  const verifierLib = await ethers.deployContract("VerifierLib");
  await verifierLib.waitForDeployment();
  const factory = await ethers.getContractFactory("UniversalVerifier", {
    libraries: { VerifierLib: await verifierLib.getAddress() },
  });
  const implementation = await factory.deploy();
  await implementation.waitForDeployment();
  const proxy = await ethers.deployContract("TransparentUpgradeableProxy", [
    await implementation.getAddress(),
    await owner.getAddress(),
    factory.interface.encodeFunctionData("initialize", [
      ethers.ZeroAddress,
      await owner.getAddress(),
    ]),
  ]);
  await proxy.waitForDeployment();
  const verifier: any = await ethers.getContractAt(
    "UniversalVerifier",
    await proxy.getAddress(),
    owner,
  );
  const authValidator = await ethers.deployContract("AuthValidatorStub");
  const requestValidator = await ethers.deployContract("RequestValidatorStub");
  await authValidator.waitForDeployment();
  await requestValidator.waitForDeployment();
  const registration: ValidatorRegistration = {
    universalVerifier: await verifier.getAddress(),
    requestValidators: [
      { name: "RequestValidatorStub", address: await requestValidator.getAddress() },
    ],
    authMethods: [
      { authMethod: "authV3", validator: await authValidator.getAddress(), params: "0x1234" },
      { authMethod: "embeddedAuth", validator: await verifier.getAddress(), params: "0x" },
    ],
  };
  return { owner, observer, verifier, registration, authValidator };
}

async function rejectedWithoutTransaction(
  work: () => Promise<unknown>,
  signer: { getAddress(): Promise<string> },
  message: string,
) {
  const signerAddress = await signer.getAddress();
  const nonce = await ethers.provider.getTransactionCount(signerAddress);
  await expect(work()).to.be.rejectedWith(message);
  expect(await ethers.provider.getTransactionCount(signerAddress)).to.equal(nonce);
}

describe("Validator registration address sources", () => {
  it("selects the MeHub basic registry path without using generic params/create2 addresses", () => {
    const contractNames = [
      contractsInfo.UNIVERSAL_VERIFIER,
      contractsInfo.VALIDATOR_MTP,
      contractsInfo.VALIDATOR_SIG,
      contractsInfo.VALIDATOR_V3,
      contractsInfo.VALIDATOR_V3_STABLE,
      contractsInfo.VALIDATOR_LINKED_MULTI_QUERY,
      contractsInfo.VALIDATOR_LINKED_MULTI_QUERY_STABLE,
      contractsInfo.VALIDATOR_AUTH_V2,
      contractsInfo.VALIDATOR_AUTH_V3,
      contractsInfo.VALIDATOR_AUTH_V3_8_32,
      contractsInfo.VALIDATOR_ETH_IDENTITY,
    ];
    const registry = Object.fromEntries(
      contractNames.map((c) => [`${c.name}Module#${c.name}`, uvAddress]),
    );
    const { registration, sourceDescription } = loadValidatorRegistration(
      {
        source: "ignition",
        strategy: "basic",
        chainId: 2401,
        networkName: "me-hub",
        // Generic split-deploy parameters must not influence the basic registry.
        parameters: {
          UniversalVerifierAtModule: { proxyAddress: requestAddress },
          DeploymentId: "chain-2401",
        },
      },
      (filename) => {
        expect(filename).to.include(
          "/chain-2401-simple-deploy-basic-strategy-london-v1/deployed_addresses.json",
        );
        return registry;
      },
    );
    expect(sourceDescription).to.include(
      "chain-2401-simple-deploy-basic-strategy-london-v1/deployed_addresses.json",
    );
    expect(registration.universalVerifier).to.equal(uvAddress);
    expect(registration.universalVerifier).not.to.equal(
      contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
    );
    expect(registration.requestValidators).to.have.length(6);
    expect(registration.authMethods.map((m) => m.authMethod)).to.deep.equal([
      "authV2",
      "authV3",
      "authV3-8-32",
      "ethIdentity",
      "embeddedAuth",
    ]);
    expect(registration.authMethods.at(-1)!.validator).to.equal(registration.universalVerifier);
  });

  it("accepts only proxy aliases and rejects conflicting registry aliases", () => {
    const registry = {
      "UniversalVerifierModule#UniversalVerifier": uvAddress,
      "AuthV3ValidatorModule#AuthV3Validator": authAddress,
      "AuthV2ValidatorImplementationModule#AuthV2Validator": requestAddress,
    };
    const registration = registrationFromIgnition(registry);
    expect(registration.authMethods.map((m) => m.authMethod)).to.deep.equal([
      "authV3",
      "embeddedAuth",
    ]);
    expect(registration.omitted).to.include("authV2");
    expect(() =>
      registrationFromIgnition({
        ...registry,
        "AuthV3ValidatorProxyModule#TransparentUpgradeableProxy": requestAddress,
      }),
    ).to.throw("conflicting proxy addresses");
  });

  it("uses explicit AtModule proxies for basic, with no unified fallback", () => {
    const parameters = {
      UniversalVerifierAtModule: { proxyAddress: uvAddress },
      AuthV3ValidatorAtModule: { proxyAddress: authAddress },
    };
    const registration = registrationFromParameters(parameters, "basic");
    expect(registration.universalVerifier).to.equal(uvAddress);
    expect(registration.authMethods[0].validator).to.equal(authAddress);
    expect(registration.requestValidators).to.have.length(0);
    expect(registration.omitted).to.include("v3stable");
    expect(() =>
      registrationFromParameters(
        {
          ...parameters,
          AuthV2ValidatorProxyFirstImplementationModule: {},
        },
        "basic",
      ),
    ).to.throw("no unified fallback");
  });

  it("uses unified addresses only for selected create2 contracts, never absent optionals", () => {
    const registration = registrationFromParameters(
      {
        UniversalVerifierProxyFirstImplementationModule: {},
        CredentialAtomicQueryV3ValidatorProxyFirstImplementationModule: {},
        AuthV2ValidatorAtModule: { proxyAddress: authAddress },
      },
      "create2",
    );
    expect(registration.universalVerifier).to.equal(
      contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
    );
    expect(registration.requestValidators).to.deep.equal([
      { name: contractsInfo.VALIDATOR_V3.name, address: contractsInfo.VALIDATOR_V3.unifiedAddress },
    ]);
    expect(registration.authMethods[0].validator).to.equal(authAddress);
    expect(registration.omitted).to.include.members(["authV3", "authV3-8-32", "lmqstable"]);
    expect(() => registrationFromParameters({}, "create2")).to.throw(
      "UniversalVerifier proxy is not configured/deployed",
    );
  });

  it("loads legacy outputs from scripts/deployments_output and validates their metadata", () => {
    const { registration, sourceDescription } = loadValidatorRegistration(
      {
        source: "legacy",
        strategy: "create2",
        chainId: 2401,
        networkName: "me-hub",
      },
      (filename) => {
        expect(filename).to.include("/scripts/deployments_output/");
        const metadata = { chainId: 2401, network: "me-hub", deployStrategy: "create2" };
        return filename.includes("deploy_universal_verifier_output_")
          ? { ...metadata, universalVerifier: uvAddress }
          : { ...metadata, validatorsInfo: [{ validatorType: "v3", validator: requestAddress }] };
      },
    );
    expect(sourceDescription).to.include("/scripts/deployments_output/");
    expect(registration.universalVerifier).to.equal(uvAddress);
    expect(registration.requestValidators.map((v) => v.name)).to.deep.equal([
      contractsInfo.VALIDATOR_V3.name,
    ]);
    const metadata = { chainId: 2401, network: "me-hub" };
    const uv = { ...metadata, universalVerifier: uvAddress };
    const entries = [
      { validatorType: "authV3-8-32", validator: authAddress },
      { validatorType: "v3stable", validator: requestAddress },
    ];
    const expected = { chainId: 2401, networkName: "me-hub", strategy: "basic" as const };
    expect(
      registrationFromLegacy(uv, { ...metadata, validatorsInfo: entries }, expected).authMethods[0]
        .authMethod,
    ).to.equal("authV3-8-32");
    expect(() =>
      registrationFromLegacy(
        { ...uv, chainId: 1 },
        { ...metadata, validatorsInfo: entries },
        expected,
      ),
    ).to.throw("chainId/network");
    expect(() =>
      registrationFromLegacy(
        { ...uv, deployStrategy: "create2" },
        { ...metadata, validatorsInfo: entries },
        expected,
      ),
    ).to.throw("deployStrategy");
    expect(() =>
      registrationFromLegacy(
        uv,
        {
          ...metadata,
          validatorsInfo: [...entries, { validatorType: "v3stable", validator: authAddress }],
        },
        expected,
      ),
    ).to.throw("Conflicting legacy addresses");
  });

  it("allows an explicit read-only registry ID, rejects mismatched IDs and incompatible overrides", () => {
    const result = loadValidatorRegistration(
      {
        source: "ignition",
        strategy: "basic",
        chainId: 2401,
        networkName: "me-hub",
        deploymentId: "chain-2401-registration-fixture",
      },
      () => ({ "UniversalVerifierAtModule#UniversalVerifier": uvAddress }),
    );
    expect(result.sourceDescription).to.include(
      "/chain-2401-registration-fixture/deployed_addresses.json",
    );
    expect(() =>
      loadValidatorRegistration({
        source: "ignition",
        strategy: "basic",
        chainId: 2401,
        networkName: "me-hub",
        deploymentId: "chain-1",
      }),
    ).to.throw("Invalid registry deployment ID");
    expect(() =>
      loadValidatorRegistration({
        source: "params",
        strategy: "basic",
        chainId: 2401,
        networkName: "me-hub",
        deploymentId: "chain-2401",
        parameters: {},
      }),
    ).to.throw("only valid with REGISTRATION_SOURCE=ignition");
  });
});

describe("Validator registration preflight and idempotence", () => {
  it("registers string auth methods with their validator and original params, then makes no new transactions", async () => {
    const { owner, observer, verifier, registration } = await networkHelpers.loadFixture(fixture);
    const run = (signer = owner, connectedVerifier = verifier) =>
      registerValidators({
        provider: ethers.provider,
        signer,
        verifier: connectedVerifier,
        registration,
        log: ignoredLog,
      });
    expect(await run()).to.deep.equal({ whitelisted: 1, authMethodsAdded: 2 });
    const auth = await verifier.getAuthMethod("authV3");
    expect(auth.validator).to.equal(registration.authMethods[0].validator);
    expect(auth.params).to.equal("0x1234");
    expect(auth.isActive).to.equal(true);
    const embedded = await verifier.getAuthMethod("embeddedAuth");
    expect(embedded.validator).to.equal(await verifier.getAddress());
    const nonce = await ethers.provider.getTransactionCount(await owner.getAddress());
    expect(await run()).to.deep.equal({ whitelisted: 0, authMethodsAdded: 0 });
    expect(await ethers.provider.getTransactionCount(await owner.getAddress())).to.equal(nonce);
    const observerNonce = await ethers.provider.getTransactionCount(await observer.getAddress());
    expect(await run(observer, verifier.connect(observer))).to.deep.equal({
      whitelisted: 0,
      authMethodsAdded: 0,
    });
    expect(await ethers.provider.getTransactionCount(await observer.getAddress())).to.equal(
      observerNonce,
    );
  });

  it("preserves the basic graph's known embeddedAuth placeholder and rejects other bindings", async () => {
    const { owner, observer, verifier, registration } = await networkHelpers.loadFixture(fixture);
    const embedded = registration.authMethods[1];
    await (
      await verifier.setAuthMethod({
        ...embedded,
        validator: contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
      })
    ).wait();
    const logs: string[] = [];
    expect(
      await registerValidators({
        provider: ethers.provider,
        signer: owner,
        verifier,
        registration,
        log: (message) => logs.push(message),
      }),
    ).to.deep.equal({ whitelisted: 1, authMethodsAdded: 1 });
    expect(
      logs.some((message) => message.includes("Preserving legacy embeddedAuth placeholder")),
    ).to.equal(true);
    expect((await verifier.getAuthMethod("embeddedAuth")).validator).to.equal(
      contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
    );
    const nonce = await ethers.provider.getTransactionCount(await observer.getAddress());
    expect(
      await registerValidators({
        provider: ethers.provider,
        signer: observer,
        verifier: verifier.connect(observer),
        registration,
        log: ignoredLog,
      }),
    ).to.deep.equal({ whitelisted: 0, authMethodsAdded: 0 });
    expect(await ethers.provider.getTransactionCount(await observer.getAddress())).to.equal(nonce);
  });

  it("rejects arbitrary embeddedAuth bindings rather than accepting any placeholder", async () => {
    const { owner, verifier, registration, authValidator } =
      await networkHelpers.loadFixture(fixture);
    await (
      await verifier.setAuthMethod({
        ...registration.authMethods[1],
        validator: await authValidator.getAddress(),
      })
    ).wait();
    await rejectedWithoutTransaction(
      () =>
        registerValidators({
          provider: ethers.provider,
          signer: owner,
          verifier,
          registration,
          log: ignoredLog,
        }),
      owner,
      "embeddedAuth binding mismatch",
    );
  });

  it("reports omitted optionals and registers only the actual selected set", async () => {
    const { owner, verifier, registration } = await networkHelpers.loadFixture(fixture);
    const selected = registrationFromIgnition({
      "UniversalVerifierModule#UniversalVerifier": registration.universalVerifier,
    });
    expect(selected.omitted).to.have.length(10);
    expect(
      await registerValidators({
        provider: ethers.provider,
        signer: owner,
        verifier,
        registration: selected,
        log: ignoredLog,
      }),
    ).to.deep.equal({ whitelisted: 0, authMethodsAdded: 1 });
    expect(await verifier.authMethodExists("authV3")).to.equal(false);
  });

  for (const conflict of ["validator", "params", "disabled"] as const) {
    it(`rejects an existing auth ${conflict} conflict before any registration transaction`, async () => {
      const { owner, verifier, registration } = await networkHelpers.loadFixture(fixture);
      const expected = registration.authMethods[0];
      await (
        await verifier.setAuthMethod({
          ...expected,
          ...(conflict === "validator" ? { validator: registration.universalVerifier } : {}),
          ...(conflict === "params" ? { params: "0xabcd" } : {}),
        })
      ).wait();
      if (conflict === "disabled")
        await (await verifier.disableAuthMethod(expected.authMethod)).wait();
      await rejectedWithoutTransaction(
        () =>
          registerValidators({
            provider: ethers.provider,
            signer: owner,
            verifier,
            registration,
            log: ignoredLog,
          }),
        owner,
        conflict === "disabled" ? "is disabled" : "binding mismatch",
      );
      expect(
        await verifier.isWhitelistedValidator(registration.requestValidators[0].address),
      ).to.equal(false);
      expect(await verifier.authMethodExists("embeddedAuth")).to.equal(false);
    });
  }

  it("requires the UV owner before configuring any missing item", async () => {
    const { observer, verifier, registration } = await networkHelpers.loadFixture(fixture);
    await rejectedWithoutTransaction(
      () =>
        registerValidators({
          provider: ethers.provider,
          signer: observer,
          verifier: verifier.connect(observer),
          registration,
          log: ignoredLog,
        }),
      observer,
      "is not UniversalVerifier owner",
    );
    expect(await verifier.authMethodExists("authV3")).to.equal(false);
  });

  for (const missing of ["uv", "last-auth", "create2"] as const) {
    it(`rejects missing bytecode (${missing}) before sending any transaction`, async () => {
      const { owner, verifier, registration } = await networkHelpers.loadFixture(fixture);
      let selected = structuredClone(registration);
      let connected = verifier;
      if (missing === "uv") {
        selected.universalVerifier = await owner.getAddress();
        connected = await ethers.getContractAt(
          "UniversalVerifier",
          selected.universalVerifier,
          owner,
        );
      } else if (missing === "last-auth") {
        selected.authMethods.push({
          authMethod: "absent",
          validator: await owner.getAddress(),
          params: "0x",
        });
      } else {
        selected = registrationFromParameters(
          {
            UniversalVerifierAtModule: { proxyAddress: registration.universalVerifier },
            AuthV3ValidatorProxyFirstImplementationModule: {},
          },
          "create2",
        );
      }
      await rejectedWithoutTransaction(
        () =>
          registerValidators({
            provider: ethers.provider,
            signer: owner,
            verifier: connected,
            registration: selected,
            log: ignoredLog,
          }),
        owner,
        "No deployed code",
      );
      expect(
        await verifier.isWhitelistedValidator(registration.requestValidators[0].address),
      ).to.equal(false);
    });
  }

  it("rejects invalid addresses, params, and object-valued auth names without transactions", async () => {
    const { owner, verifier, registration } = await networkHelpers.loadFixture(fixture);
    for (const [badMethod, message] of [
      [{ ...registration.authMethods[0], validator: undefined }, "missing or invalid address"],
      [{ ...registration.authMethods[0], params: "0x1" }, "Invalid bytes params"],
      [
        { ...registration.authMethods[0], authMethod: { authMethod: "authV3", params: "0x" } },
        "non-empty string",
      ],
    ] as const) {
      await rejectedWithoutTransaction(
        () =>
          registerValidators({
            provider: ethers.provider,
            signer: owner,
            verifier,
            registration: { ...registration, authMethods: [badMethod as any] },
            log: ignoredLog,
          }),
        owner,
        message,
      );
    }
  });
});
