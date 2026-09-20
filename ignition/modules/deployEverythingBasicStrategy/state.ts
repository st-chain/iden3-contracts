import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { Poseidon1Module, SmtLibModule } from "./libraries";
import { Groth16VerifierStateTransitionModule } from "./groth16verifiers";
import {
  contractsInfo,
  TRANSPARENT_UPGRADEABLE_PROXY_ABI,
  TRANSPARENT_UPGRADEABLE_PROXY_BYTECODE,
} from "../../../helpers/constants";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const StateLibModule = buildModule("StateLibModule", (m) => {
  const stateLib = m.contract("StateLib");
  return { stateLib };
});

const StateImplementationModule = buildModule("StateImplementationModule", (m) => {
  const { groth16VerifierStateTransition: groth16Verifier } = m.useModule(
    Groth16VerifierStateTransitionModule,
  );
  const { stateLib } = m.useModule(StateLibModule);
  const { smtLib } = m.useModule(SmtLibModule);

  const implementation = m.contract(contractsInfo.STATE.name, [], {
    libraries: {
      StateLib: stateLib,
      SmtLib: smtLib,
    },
  });

  return {
    groth16Verifier,
    implementation,
    stateLib,
    smtLib,
  };
});

const StateProxyModule = buildModule("StateProxyModule", (m) => {
  const { groth16Verifier, implementation, stateLib, smtLib } =
    m.useModule(StateImplementationModule);

  const proxyAdminOwner = m.getAccount(0);

  const defaultIdType = m.getParameter("defaultIdType");
  if (!defaultIdType) {
    throw new Error(`Failed to find defaultIdType in Map for chainId ${defaultIdType}`);
  }
  const initializeData = m.encodeFunctionCall(implementation, "initialize", [
    groth16Verifier,
    defaultIdType,
    proxyAdminOwner,
    ZERO_ADDRESS,
  ]);

  const proxy = m.contract(
    "TransparentUpgradeableProxy",
    {
      abi: TRANSPARENT_UPGRADEABLE_PROXY_ABI,
      contractName: "TransparentUpgradeableProxy",
      bytecode: TRANSPARENT_UPGRADEABLE_PROXY_BYTECODE,
      sourceName: "",
      linkReferences: {},
    },
    [implementation, proxyAdminOwner, initializeData],
  );

  return { proxy, implementation, stateLib, smtLib, groth16Verifier };
});

const StateModule = buildModule("StateModule", (m) => {
  const { proxy, implementation, stateLib, smtLib, groth16Verifier } =
    m.useModule(StateProxyModule);
  const state = m.contractAt(contractsInfo.STATE.name, proxy);
  return { state, implementation, stateLib, smtLib, groth16Verifier };
});

export default StateModule;
