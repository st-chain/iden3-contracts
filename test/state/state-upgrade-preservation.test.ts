import { expect } from "chai";
import { poseidonContract } from "circomlibjs";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { contractsInfo } from "../../helpers/constants";
import UpgradeStateModule from "../../ignition/modules/upgrades/upgradeState";
import { isStateUpgradeEntrypoint, upgradeState } from "../../scripts/upgrade/state/state-upgrade";

// Osaka reserves 0x100 for P256; use a local pre-Osaka network so the Poseidon adapter runs.
const connection = await network.create({
  network: "default",
  override: { chainId: 2401, hardfork: "cancun" },
});
const { ethers, ignition, networkHelpers } = connection;
const abi = ethers.AbiCoder.defaultAbiCoder();
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const moduleId =
  "UpgradeStateModuleV" + contractsInfo.STATE.version.replaceAll(".", "_").replaceAll("-", "_");
const proofsType = "tuple(string proofType,bytes proof)[]";
const localId = 0xc101n; // Little-endian me-hub ID type 0x01c1.
const foreignId = 0xdeadn;
const foreignIdType = "0xbeef";
const foreignState = 456n;
const foreignRoot = 789n;
const stateReplacedAt = 1700000001n;
const rootReplacedAt = 1700000002n;

const addressAt = async (address: string, slot: string) =>
  ethers.getAddress(ethers.dataSlice(await ethers.provider.getStorage(address, slot), 12));

const encodeProofs = (proofs: { proofType: string; proof: string }[]) =>
  abi.encode([proofsType], [proofs]);

async function deployFixture(zeroValidator: boolean) {
  const [proxyAdminOwner, stateOwner, outsider] = await ethers.getSigners();
  // Reuse circomlibjs's real contracts, adapting their ABI to the raw-input 0x100 precompile.
  const poseidons: any[] = [];
  for (const inputs of [1, 2, 3]) {
    const poseidon = await new ethers.ContractFactory(
      poseidonContract.generateABI(inputs),
      poseidonContract.createCode(inputs),
      proxyAdminOwner,
    ).deploy();
    await poseidon.waitForDeployment();
    poseidons.push(poseidon);
  }
  const adapter = await ethers.deployContract("StateUpgradePoseidonAdapter", [
    await poseidons[0].getAddress(),
    await poseidons[1].getAddress(),
    await poseidons[2].getAddress(),
  ]);
  await networkHelpers.setCode(
    "0x0000000000000000000000000000000000000100",
    await ethers.provider.getCode(await adapter.getAddress()),
  );

  const stateLib = await ethers.deployContract("StateLib");
  const smtLib = await ethers.deployContract("SmtLib");
  const verifier = await ethers.deployContract("Groth16VerifierStub");
  const validator = await ethers.deployContract("StateUpgradeValidatorMock");
  const implementation = await ethers.deployContract("State", [], {
    libraries: { StateLib: await stateLib.getAddress(), SmtLib: await smtLib.getAddress() },
  });
  const previous = await ethers.deployContract("StateUpgradePreviousVersion", [
    await implementation.getAddress(),
  ]);
  const proxy = await ethers.deployContract("TransparentUpgradeableProxy", [
    await previous.getAddress(),
    proxyAdminOwner.address,
    implementation.interface.encodeFunctionData("initialize", [
      await verifier.getAddress(),
      "0x01c1",
      stateOwner.address,
      await validator.getAddress(),
    ]),
  ]);
  const state = await ethers.getContractAt("State", proxy.target, stateOwner);
  const proxyAdmin = await ethers.getContractAt(
    "ProxyAdmin",
    await addressAt(await proxy.getAddress(), adminSlot),
    proxyAdminOwner,
  );
  await state.processCrossChainProofs(
    encodeProofs([
      {
        proofType: "stateProof",
        proof: abi.encode(
          ["uint256", "uint256", "uint256"],
          [foreignId, foreignState, stateReplacedAt],
        ),
      },
      {
        proofType: "globalStateProof",
        proof: abi.encode(
          ["bytes2", "uint256", "uint256"],
          [foreignIdType, foreignRoot, rootReplacedAt],
        ),
      },
    ]),
  );
  if (zeroValidator) {
    // Historical data stays cached even when its validator has already been disabled by the owner.
    await state.setCrossChainProofValidator(ethers.ZeroAddress);
  }
  await validator.setRejectProofs(true);
  await state.transitState(
    localId,
    999,
    1000,
    true,
    [0, 0],
    [
      [0, 0],
      [0, 0],
    ],
    [0, 0],
  );
  const index = await poseidons[0]["poseidon(uint256[1])"]([localId]);
  const gistRoot = await poseidons[2]["poseidon(uint256[3])"]([index, 1000, 1]);
  expect(await state.getGISTRoot()).to.equal(gistRoot);
  expect(gistRoot).not.to.equal(0);
  expect(await state.owner()).not.to.equal(await proxyAdmin.owner());

  return {
    state,
    proxy,
    proxyAdmin,
    proxyAdminOwner,
    stateOwner,
    outsider,
    implementation,
    previous,
    verifier,
    validator,
    smtLib,
    gistRoot,
    validatorAddress: zeroValidator ? ethers.ZeroAddress : await validator.getAddress(),
  };
}

async function zeroValidatorFixture() {
  return deployFixture(true);
}

async function configuredValidatorFixture() {
  return deployFixture(false);
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

async function expectPreserved(fixture: Fixture) {
  const {
    state,
    proxy,
    proxyAdmin,
    stateOwner,
    proxyAdminOwner,
    verifier,
    gistRoot,
    validatorAddress,
  } = fixture;
  expect(await state.getAddress()).to.equal(await proxy.getAddress());
  expect(await addressAt(await proxy.getAddress(), adminSlot)).to.equal(
    await proxyAdmin.getAddress(),
  );
  expect(await proxyAdmin.owner()).to.equal(proxyAdminOwner.address);
  expect(await state.owner()).to.equal(stateOwner.address);
  expect(await state.getDefaultIdType()).to.equal("0x01c1");
  expect(await state.getVerifier()).to.equal(await verifier.getAddress());
  expect(await state.getGISTRoot()).to.equal(gistRoot);
  expect(await state.getCrossChainProofValidator()).to.equal(validatorAddress);
  expect(await state.getStateReplacedAt(foreignId, foreignState)).to.equal(stateReplacedAt);
  expect(await state.getGistRootReplacedAt(foreignIdType, foreignRoot)).to.equal(rootReplacedAt);
  expect((await state.getStateInfoById(localId)).state).to.equal(1000);
}

async function moduleParameters(fixture: Fixture) {
  return {
    [moduleId]: {
      proxyAddress: await fixture.proxy.getAddress(),
      proxyAdminAddress: await fixture.proxyAdmin.getAddress(),
      smtLibContractAddress: await fixture.smtLib.getAddress(),
    },
  };
}

async function scriptParameters(fixture: Fixture): Promise<any> {
  return {
    StateAtModule: {
      proxyAddress: await fixture.proxy.getAddress(),
      proxyAdminAddress: await fixture.proxyAdmin.getAddress(),
      historicalField: "keep",
    },
    SmtLibAtModule: { contractAddress: await fixture.smtLib.getAddress() },
    CrossChainProofValidatorModule: { oracleSigningAddress: fixture.outsider.address },
    CrossChainProofValidatorAtModule: { contractAddress: await fixture.validator.getAddress() },
    Poseidon1AtModule: { contractAddress: fixture.outsider.address },
    [moduleId]: {
      oracleSigningAddress: fixture.outsider.address,
      poseidon1ContractAddress: fixture.outsider.address,
    },
  };
}

function scriptHelpers(fixture: Fixture) {
  const writes: any[] = [];
  const verifications: string[] = [];
  return {
    writes,
    verifications,
    getStateContractAddress: async () => fixture.proxy.getAddress(),
    writeDeploymentParameters: async (parameters: any) => {
      expect(await addressAt(await fixture.proxy.getAddress(), implementationSlot)).to.equal(
        parameters.StateNewImplementationAtModule.contractAddress,
      );
      writes.push(structuredClone(parameters));
    },
    verifyContract: async (address: any) => {
      expect(writes.length).to.equal(1, "save successful upgrade before verifying contracts");
      verifications.push(address);
      return true;
    },
  };
}

const noSideEffects = {
  getStateContractAddress: async () => {
    throw new Error("unexpected address fallback");
  },
  writeDeploymentParameters: async () => {
    throw new Error("unexpected parameter write");
  },
  verifyContract: async () => {
    throw new Error("unexpected contract verification");
  },
};

describe("State upgrade configuration preservation", function () {
  this.timeout(120000);

  for (const [label, fixtureFn] of [
    ["zero validator", zeroValidatorFixture],
    ["existing nonzero validator", configuredValidatorFixture],
  ] as const) {
    it(`module upgrades a real proxy with ${label}, distinct owners, and historical foreign caches`, async () => {
      const fixture = await networkHelpers.loadFixture(fixtureFn);
      const beforeBlock = await ethers.provider.getBlockNumber();
      const result = await ignition.deploy(UpgradeStateModule, {
        parameters: await moduleParameters(fixture),
      });
      expect(result).not.to.have.property("crossChainProofValidator");
      expect(await result.newImplementation.getAddress()).not.to.equal(
        await fixture.previous.getAddress(),
      );
      expect(await addressAt(await fixture.proxy.getAddress(), implementationSlot)).to.equal(
        await result.newImplementation.getAddress(),
      );
      expect(await fixture.state.VERSION()).to.equal(contractsInfo.STATE.version);
      await expectPreserved(fixture);

      const upgrades: any[] = [];
      for (
        let number = beforeBlock + 1;
        number <= (await ethers.provider.getBlockNumber());
        number++
      ) {
        const block = await ethers.provider.getBlock(number);
        for (const hash of block!.transactions) {
          const tx = await ethers.provider.getTransaction(hash);
          if (tx?.to?.toLowerCase() === (await fixture.proxyAdmin.getAddress()).toLowerCase()) {
            upgrades.push(fixture.proxyAdmin.interface.parseTransaction({ data: tx.data }));
          }
        }
      }
      expect(upgrades.length).to.equal(1);
      expect(upgrades[0].name).to.equal("upgradeAndCall");
      expect(upgrades[0].args[2]).to.equal(fixture.state.interface.encodeFunctionData("VERSION"));
      expect(upgrades[0].args[2]).not.to.equal("0x");

      // Both empty representations avoid calling even an existing validator that always rejects.
      await expect(fixture.state.processCrossChainProofs("0x")).not.to.revert(ethers);
      await expect(fixture.state.processCrossChainProofs(encodeProofs([]))).not.to.revert(ethers);
      expect(await fixture.validator.globalProofCalls()).to.equal(1);
      expect(await fixture.validator.identityProofCalls()).to.equal(1);
      for (const proofType of ["stateProof", "globalStateProof"]) {
        const call = fixture.state.processCrossChainProofs(
          encodeProofs([{ proofType, proof: "0x1234" }]),
        );
        if (label === "zero validator") {
          await expect(call).to.revert(ethers);
        } else {
          await expect(call).to.be.revertedWith("State upgrade mock rejects proofs");
        }
      }
      await expectPreserved(fixture);
      await fixture.state.transitState(
        localId,
        1000,
        1001,
        false,
        [0, 0],
        [
          [0, 0],
          [0, 0],
        ],
        [0, 0],
      );
      expect(await fixture.state.getGISTRoot()).not.to.equal(fixture.gistRoot);
    });

    it(`script preserves ${label} and historical parameters without requiring the State owner signer`, async () => {
      const fixture = await networkHelpers.loadFixture(fixtureFn);
      const parameters = await scriptParameters(fixture);
      const historicalValidatorParams = structuredClone(parameters.CrossChainProofValidatorModule);
      const historicalValidatorAddress = structuredClone(
        parameters.CrossChainProofValidatorAtModule,
      );
      const historicalUpgradeParams = structuredClone(parameters[moduleId]);
      const helpers = scriptHelpers(fixture);
      const result = await upgradeState(connection, parameters, helpers);
      expect(result.upgraded).to.equal(true);
      expect(helpers.writes.length).to.equal(1);
      expect(parameters.CrossChainProofValidatorModule).to.deep.equal(historicalValidatorParams);
      expect(parameters.CrossChainProofValidatorAtModule).to.deep.equal(historicalValidatorAddress);
      expect(parameters[moduleId]).to.include(historicalUpgradeParams);
      expect(parameters.StateAtModule.historicalField).to.equal("keep");
      expect(helpers.verifications).not.to.include(await fixture.validator.getAddress());
      await expectPreserved(fixture);
    });
  }

  it("uses the same fallback State proxy for preflight, module parameters, and persisted results", async () => {
    const fixture = await networkHelpers.loadFixture(zeroValidatorFixture);
    const parameters = await scriptParameters(fixture);
    delete parameters.StateAtModule.proxyAddress;
    delete parameters[moduleId];
    delete parameters.Poseidon1AtModule;
    delete parameters.CrossChainProofValidatorModule;
    delete parameters.CrossChainProofValidatorAtModule;
    const helpers = scriptHelpers(fixture);
    await upgradeState(connection, parameters, helpers);
    expect(parameters[moduleId]).to.deep.equal((await moduleParameters(fixture))[moduleId]);
    expect(parameters.StateAtModule.proxyAddress).to.equal(await fixture.proxy.getAddress());
    await expectPreserved(fixture);
  });

  it("checks the actual admin and its owner even before a same-version early return", async () => {
    const fixture = await networkHelpers.loadFixture(zeroValidatorFixture);
    await ignition.deploy(UpgradeStateModule, { parameters: await moduleParameters(fixture) });
    const parameters = await scriptParameters(fixture);
    // Same-version return does not require an SmtLib address or force another deployment.
    delete parameters.SmtLibAtModule;
    const before = await ethers.provider.getBlockNumber();
    const result = await upgradeState(connection, parameters, noSideEffects);
    expect(result.upgraded).to.equal(false);
    expect(await ethers.provider.getBlockNumber()).to.equal(before);

    const wrongAdmin = await ethers.deployContract("ProxyAdmin", [fixture.proxyAdminOwner.address]);
    const wrongParameters = structuredClone(parameters);
    wrongParameters.StateAtModule.proxyAdminAddress = await wrongAdmin.getAddress();
    await expect(upgradeState(connection, wrongParameters, noSideEffects)).to.be.rejectedWith(
      "does not match configured ProxyAdmin",
    );

    await fixture.proxyAdmin.transferOwnership(fixture.outsider.address);
    await expect(upgradeState(connection, parameters, noSideEffects)).to.be.rejectedWith(
      "is not ProxyAdmin owner",
    );
  });

  it("rejects a State-owner-only signer before deploying or writing anything", async () => {
    const fixture = await networkHelpers.loadFixture(zeroValidatorFixture);
    await fixture.proxyAdmin.transferOwnership(fixture.outsider.address);
    const stateOwnerConnection = {
      ethers: new Proxy(ethers, {
        get(target, property, receiver) {
          return property === "getSigners"
            ? async () => [fixture.stateOwner]
            : Reflect.get(target, property, receiver);
        },
      }),
      ignition,
    };
    const before = await ethers.provider.getBlockNumber();
    await expect(
      upgradeState(stateOwnerConnection, await scriptParameters(fixture), noSideEffects),
    ).to.be.rejectedWith("is not ProxyAdmin owner");
    expect(await ethers.provider.getBlockNumber()).to.equal(before);
    expect(await addressAt(await fixture.proxy.getAddress(), implementationSlot)).to.equal(
      await fixture.previous.getAddress(),
    );
  });

  it("rejects invalid or code-less addresses before deploying", async () => {
    const fixture = await networkHelpers.loadFixture(zeroValidatorFixture);
    for (const address of [ethers.ZeroAddress, "invalid", fixture.outsider.address]) {
      const parameters = await scriptParameters(fixture);
      parameters.StateAtModule.proxyAddress = address;
      await expect(upgradeState(connection, parameters, noSideEffects)).to.be.rejected;
    }
  });

  it("retains confirmed deployment parameters even when explorer verification fails", async () => {
    const fixture = await networkHelpers.loadFixture(zeroValidatorFixture);
    const helpers = scriptHelpers(fixture);
    helpers.verifyContract = async () => {
      throw new Error("test explorer unavailable");
    };
    await expect(
      upgradeState(connection, await scriptParameters(fixture), helpers),
    ).to.be.rejectedWith("test explorer unavailable");
    expect(helpers.writes.length).to.equal(1);
    await expectPreserved(fixture);
  });

  it("does not run on import and recognizes direct and Hardhat 3 run entrypoints", () => {
    const script = fileURLToPath(
      new URL("../../scripts/upgrade/state/state-upgrade.ts", import.meta.url),
    );
    expect(isStateUpgradeEntrypoint(["node", script])).to.equal(true);
    expect(
      isStateUpgradeEntrypoint(["node", "hardhat", "run", script, "--network", "default"]),
    ).to.equal(true);
    expect(
      isStateUpgradeEntrypoint(["node", "hardhat", "--build-profile", "me-hub", "run", script]),
    ).to.equal(true);
    expect(isStateUpgradeEntrypoint(["node", "hardhat", "test", script])).to.equal(false);
    expect(isStateUpgradeEntrypoint(["node", "hardhat", "run", "other-script.ts"])).to.equal(false);
    expect(isStateUpgradeEntrypoint(["node", "other-importer.ts"])).to.equal(false);
  });
});
