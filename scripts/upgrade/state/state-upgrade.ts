import { expect } from "chai";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type UpgradeHelpers = Pick<
  typeof import("../../../helpers/helperUtils"),
  "getStateContractAddress" | "verifyContract" | "writeDeploymentParameters"
>;

export async function upgradeState(
  { ethers, ignition }: Pick<NetworkConnection, "ethers" | "ignition">,
  parameters: any,
  helpers: UpgradeHelpers,
) {
  const { contractsInfo } = await import("../../../helpers/constants");
  const { default: UpgradeStateModule } =
    await import("../../../ignition/modules/upgrades/upgradeState");
  const stateContractAddress =
    parameters.StateAtModule?.proxyAddress || (await helpers.getStateContractAddress());
  const proxyAdminAddress = parameters.StateAtModule?.proxyAdminAddress;

  async function requireContract(label: string, address: string | undefined) {
    if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
      throw new Error(`${label} address is missing, invalid, or zero`);
    }
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} has no contract code at ${address}`);
    }
  }

  await requireContract("State proxy", stateContractAddress);
  await requireContract("ProxyAdmin", proxyAdminAddress);

  const readProxyAdmin = async () =>
    ethers.getAddress(
      ethers.dataSlice(await ethers.provider.getStorage(stateContractAddress, ADMIN_SLOT), 12),
    );
  const actualProxyAdminAddress = await readProxyAdmin();
  if (actualProxyAdminAddress !== ethers.getAddress(proxyAdminAddress)) {
    throw new Error(
      `State proxy admin ${actualProxyAdminAddress} does not match configured ProxyAdmin ${proxyAdminAddress}`,
    );
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No upgrade signer is available");
  }
  const signerAddress = await signer.getAddress();
  const stateContract = await ethers.getContractAt(
    contractsInfo.STATE.name,
    stateContractAddress,
    signer,
  );
  const proxyAdminAt = await ethers.getContractAt("ProxyAdmin", proxyAdminAddress, signer);
  const proxyAdminOwnerBefore = await proxyAdminAt.owner();
  const stateOwnerBefore = await stateContract.owner();

  console.log("Upgrade signer: ", signerAddress);
  console.log("ProxyAdmin owner: ", proxyAdminOwnerBefore);
  console.log("State owner (may differ from ProxyAdmin owner): ", stateOwnerBefore);
  if (ethers.getAddress(proxyAdminOwnerBefore) !== ethers.getAddress(signerAddress)) {
    throw new Error(
      `Upgrade signer ${signerAddress} is not ProxyAdmin owner ${proxyAdminOwnerBefore}`,
    );
  }

  const currentVersion = await stateContract.VERSION();
  if (currentVersion === contractsInfo.STATE.version) {
    console.log(`Contract is already upgraded to version ${contractsInfo.STATE.version}`);
    return { upgraded: false, state: stateContract };
  }
  console.log(
    `Contract is not upgraded and will upgrade version ${currentVersion} to ${contractsInfo.STATE.version}`,
  );

  const smtLibContractAddress = parameters.SmtLibAtModule?.contractAddress;
  await requireContract("SmtLib", smtLibContractAddress);
  const before = {
    defaultIdType: await stateContract.getDefaultIdType(),
    verifier: await stateContract.getVerifier(),
    gistRoot: await stateContract.getGISTRoot(),
    crossChainProofValidator: await stateContract.getCrossChainProofValidator(),
  };
  console.log(
    "Run in a maintenance window: concurrent State transitions can change the GIST root between upgrade snapshots.",
  );

  const version = "V".concat(contractsInfo.STATE.version.replaceAll(".", "_").replaceAll("-", "_"));
  const moduleId = "UpgradeStateModule".concat(version);
  parameters[moduleId] = {
    // Keep historical parameter fields, but introduce only the parameters this upgrade needs.
    ...parameters[moduleId],
    proxyAddress: stateContractAddress,
    proxyAdminAddress,
    smtLibContractAddress,
  };

  const { newImplementation, state, stateLib, proxy, proxyAdmin } = await ignition.deploy(
    UpgradeStateModule,
    {
      defaultSender: signerAddress,
      parameters,
      deploymentId: parameters.DeploymentId || undefined,
    },
  );

  parameters.StateAtModule = {
    ...parameters.StateAtModule,
    proxyAddress: proxy.target,
    proxyAdminAddress: proxyAdmin.target,
  };
  parameters.StateNewImplementationAtModule = {
    ...parameters.StateNewImplementationAtModule,
    contractAddress: newImplementation.target,
  };
  parameters.StateLibAtModule = {
    ...parameters.StateLibAtModule,
    contractAddress: stateLib.target,
  };
  // The upgrade is already mined. Preserve its addresses even if an assertion or verification fails.
  await helpers.writeDeploymentParameters(parameters);

  expect(await proxy.getAddress(), "State proxy address changed").to.equal(
    ethers.getAddress(stateContractAddress),
  );
  expect(await proxyAdmin.getAddress(), "ProxyAdmin address changed").to.equal(
    actualProxyAdminAddress,
  );
  expect(await readProxyAdmin(), "State proxy admin changed").to.equal(actualProxyAdminAddress);
  expect(
    ethers.getAddress(
      ethers.dataSlice(
        await ethers.provider.getStorage(stateContractAddress, IMPLEMENTATION_SLOT),
        12,
      ),
    ),
    "State implementation does not match the deployed upgrade",
  ).to.equal(await newImplementation.getAddress());
  expect(await proxyAdmin.owner(), "ProxyAdmin owner changed").to.equal(proxyAdminOwnerBefore);
  expect(await state.owner(), "State owner changed").to.equal(stateOwnerBefore);
  expect(await state.getDefaultIdType(), "State default ID type changed").to.equal(
    before.defaultIdType,
  );
  expect(await state.getVerifier(), "State verifier changed").to.equal(before.verifier);
  expect(
    await state.getGISTRoot(),
    "State GIST root changed; check for concurrent State transitions during the maintenance window",
  ).to.equal(before.gistRoot);
  expect(await state.getCrossChainProofValidator(), "State cross-chain validator changed").to.equal(
    before.crossChainProofValidator,
  );
  expect(await state.VERSION(), "Unexpected State version after upgrade").to.equal(
    contractsInfo.STATE.version,
  );

  await helpers.verifyContract(proxy.target, contractsInfo.STATE.verificationOpts);
  await helpers.verifyContract(newImplementation.target, {
    constructorArgsImplementation: [],
    libraries: {
      StateLib: await stateLib.getAddress(),
      SmtLib: smtLibContractAddress,
    },
  });
  await helpers.verifyContract(stateLib.target, contractsInfo.STATE_LIB.verificationOpts);

  console.log("Version after: ", await state.VERSION());
  console.log("Contract Upgrade Finished");
  return { upgraded: true, state, newImplementation, stateLib, proxy, proxyAdmin };
}

export async function main() {
  const helpers = await import("../../../helpers/helperUtils");
  return upgradeState(await network.connect(), await helpers.getDeploymentParameters(), helpers);
}

export function isStateUpgradeEntrypoint(argv: string[] = process.argv) {
  const scriptPath = fileURLToPath(import.meta.url);
  const isScriptPath = (arg: string | undefined) =>
    arg !== undefined && resolve(arg) === scriptPath;
  // Hardhat 3's `run` imports the script in-process, so argv[1] is the Hardhat CLI, not this file.
  const runIndex = argv.indexOf("run", 2);
  return isScriptPath(argv[1]) || (runIndex !== -1 && argv.slice(runIndex + 1).some(isScriptPath));
}

if (isStateUpgradeEntrypoint()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
