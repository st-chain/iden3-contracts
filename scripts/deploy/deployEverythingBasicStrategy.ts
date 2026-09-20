import DeployEverythingBasicStrategy from "../../ignition/modules/deployEverythingBasicStrategy/deployEverythingBasicStrategy";
import { getChainId, getDefaultIdType, verifyContract } from "../../helpers/helperUtils";
import { network } from "hardhat";

const { ignition } = await network.connect();

async function main() {
  const params = {
    StateProxyModule: {
      defaultIdType: (await getDefaultIdType()).defaultIdType,
    },
  };

  const {
    universalVerifier,
    universalVerifierImplementation,
    verifierLib,
    state,
    stateImplementation,
    stateLib,
    smtLib,
    identityTreeStore,
    credentialAtomicQuerySigV2Validator,
    credentialAtomicQueryMTPV2Validator,
    credentialAtomicQueryV3Validator,
    credentialAtomicQueryV3StableValidator,
    linkedMultiQueryValidator,
    linkedMultiQueryStableValidator,
    ethIdentityValidator,
    authV2Validator,
    authV3Validator,
    authV3_8_32Validator,
    universalVerifier_ManyResponsesPerUserAndRequestImplementation,
    universalVerifier_ManyResponsesPerUserAndRequest,
    verifierLib_ManyResponsesPerUserAndRequest,
  } = await ignition.deploy(DeployEverythingBasicStrategy, {
    parameters: params,
    deploymentId: `chain-${await getChainId()}-simple-deploy-basic-strategy`,
    displayUi: true,
    config: {
      blockPollingInterval: 1000,
    },
  });

  for (const contract of [
    universalVerifier,
    universalVerifierImplementation,
    verifierLib,
    state,
    stateImplementation,
    stateLib,
    smtLib,
    identityTreeStore,
    credentialAtomicQuerySigV2Validator,
    credentialAtomicQueryMTPV2Validator,
    credentialAtomicQueryV3Validator,
    credentialAtomicQueryV3StableValidator,
    linkedMultiQueryValidator,
    linkedMultiQueryStableValidator,
    ethIdentityValidator,
    authV2Validator,
    authV3Validator,
    authV3_8_32Validator,
    universalVerifier_ManyResponsesPerUserAndRequest,
    universalVerifier_ManyResponsesPerUserAndRequestImplementation,
    verifierLib_ManyResponsesPerUserAndRequest,
  ]) {
    await verifyContract(contract.target, {
      constructorArgsImplementation: [],
      libraries: {},
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
