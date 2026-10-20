import { getChainId, getConfig, getDeploymentParameters } from "../../helpers/helperUtils";
import { contractsInfo } from "../../helpers/constants";
import { network } from "hardhat";
import {
  loadValidatorRegistration,
  registerValidators,
  type RegistrationSource,
} from "./helpers/validatorRegistration";

const { ethers, networkName } = await network.connect();

async function main() {
  const [signer] = await ethers.getSigners();
  const config = getConfig();
  if (config.deployStrategy && !["basic", "create2"].includes(config.deployStrategy)) {
    throw new Error(`Unsupported DEPLOY_STRATEGY: ${config.deployStrategy}`);
  }
  const strategy = config.deployStrategy === "create2" ? "create2" : "basic";
  // Never combine a basic one-click registry with the unrelated generic deployment parameters.
  const source = (process.env.REGISTRATION_SOURCE ||
    (strategy === "basic" ? "ignition" : "params")) as RegistrationSource;
  const { registration, sourceDescription } = loadValidatorRegistration({
    source,
    strategy,
    chainId: await getChainId(),
    networkName,
    deploymentId: process.env.REGISTRATION_DEPLOYMENT_ID,
    parameters: source === "params" ? await getDeploymentParameters() : undefined,
  });
  console.log(`Registration source: ${sourceDescription}`);
  console.log(`UniversalVerifier: ${registration.universalVerifier}`);
  for (const omitted of registration.omitted ?? []) {
    console.log(`Skipped ${omitted}: not configured/deployed in the selected source`);
  }
  const verifier: any = await ethers.getContractAt(
    contractsInfo.UNIVERSAL_VERIFIER.name,
    registration.universalVerifier,
    signer,
  );
  const result = await registerValidators({
    provider: ethers.provider,
    signer,
    verifier,
    registration,
  });
  console.log(
    `Registration checked: ${result.whitelisted} request validators added, ${result.authMethodsAdded} auth methods added`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
