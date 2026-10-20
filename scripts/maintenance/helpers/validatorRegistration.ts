import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, isHexString, ZeroAddress } from "ethers";
import { contractsInfo } from "../../../helpers/constants";

const validators = [
  { type: "mtpV2", contract: contractsInfo.VALIDATOR_MTP },
  { type: "sigV2", contract: contractsInfo.VALIDATOR_SIG },
  { type: "v3", contract: contractsInfo.VALIDATOR_V3 },
  { type: "v3stable", contract: contractsInfo.VALIDATOR_V3_STABLE },
  { type: "lmq", contract: contractsInfo.VALIDATOR_LINKED_MULTI_QUERY },
  { type: "lmqstable", contract: contractsInfo.VALIDATOR_LINKED_MULTI_QUERY_STABLE },
  { type: "authV2", contract: contractsInfo.VALIDATOR_AUTH_V2, authMethod: "authV2" },
  { type: "authV3", contract: contractsInfo.VALIDATOR_AUTH_V3, authMethod: "authV3" },
  {
    type: "authV3-8-32",
    contract: contractsInfo.VALIDATOR_AUTH_V3_8_32,
    authMethod: "authV3-8-32",
  },
  {
    type: "ethIdentity",
    contract: contractsInfo.VALIDATOR_ETH_IDENTITY,
    authMethod: "ethIdentity",
  },
];

export type AuthRegistration = { authMethod: string; validator: string; params: string };
export type ValidatorRegistration = {
  universalVerifier: string;
  requestValidators: { name: string; address: string }[];
  authMethods: AuthRegistration[];
  omitted?: string[];
};
export type RegistrationSource = "ignition" | "params" | "legacy";
type DeployStrategy = "basic" | "create2";
type AddressProvider = { getCode(address: string): Promise<string> };
type Signer = { getAddress(): Promise<string> };
type Transaction = { wait(): Promise<unknown> };
type AuthMethodData = { validator: string; params: string; isActive: boolean };
export interface RegistrationVerifier {
  getAddress(): Promise<string>;
  owner(): Promise<string>;
  isWhitelistedValidator(address: string): Promise<boolean>;
  authMethodExists(authMethod: string): Promise<boolean>;
  getAuthMethod(authMethod: string): Promise<AuthMethodData>;
  addValidatorToWhitelist(address: string): Promise<Transaction>;
  setAuthMethod(method: AuthRegistration): Promise<Transaction>;
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: missing or invalid address`);
  let result: string;
  try {
    result = getAddress(value);
  } catch {
    throw new Error(`${label}: invalid address ${value}`);
  }
  if (result === ZeroAddress) throw new Error(`${label}: zero address is not allowed`);
  return result;
}

// Only proxy aliases are accepted, never implementation or Groth16 verifier addresses.
function ignitionProxy(addresses: Record<string, unknown>, name: string): string | undefined {
  const keys = [
    `${name}Module#${name}`,
    `${name}AtModule#${name}`,
    `${name}ProxyModule#TransparentUpgradeableProxy`,
    `${name}ProxyFirstImplementationModule#TransparentUpgradeableProxy`,
  ];
  const candidates = keys
    .filter((key) => Object.hasOwn(addresses, key))
    .map((key) => address(addresses[key], key));
  if (new Set(candidates).size > 1) {
    throw new Error(`${name}: conflicting proxy addresses in Ignition registry`);
  }
  return candidates[0];
}

function buildRegistration(
  getProxy: (contract: { name: string; unifiedAddress: string }) => string | undefined,
): ValidatorRegistration {
  const universalVerifier = getProxy(contractsInfo.UNIVERSAL_VERIFIER);
  if (!universalVerifier) throw new Error("UniversalVerifier proxy is not configured/deployed");
  const registration: ValidatorRegistration = {
    universalVerifier,
    requestValidators: [],
    authMethods: [],
    omitted: [],
  };
  for (const validator of validators) {
    const proxy = getProxy(validator.contract);
    if (!proxy) {
      registration.omitted!.push(validator.authMethod ?? validator.type);
    } else if (validator.authMethod) {
      registration.authMethods.push({
        authMethod: validator.authMethod,
        validator: proxy,
        params: "0x",
      });
    } else {
      registration.requestValidators.push({ name: validator.contract.name, address: proxy });
    }
  }
  registration.authMethods.push({
    authMethod: "embeddedAuth",
    validator: universalVerifier,
    params: "0x",
  });
  return registration;
}

export function registrationFromIgnition(addresses: Record<string, unknown>) {
  return buildRegistration((contract) => ignitionProxy(addresses, contract.name));
}

export function registrationFromParameters(
  parameters: Record<string, any>,
  strategy: DeployStrategy,
) {
  return buildRegistration((contract) => {
    const atModule = `${contract.name}AtModule`;
    const configured =
      Object.hasOwn(parameters, atModule) ||
      Object.hasOwn(parameters, `${contract.name}ProxyFirstImplementationModule`);
    const proxy = parameters[atModule]?.proxyAddress;
    if (proxy !== undefined && proxy !== "") return address(proxy, atModule);
    if (!configured) return undefined;
    if (strategy === "create2") return address(contract.unifiedAddress, contract.name);
    throw new Error(
      `${atModule}.proxyAddress is required for basic deployments; no unified fallback`,
    );
  });
}

export function registrationFromLegacy(
  universalVerifierOutput: Record<string, any>,
  validatorsOutput: Record<string, any>,
  expected: { chainId: number; networkName: string; strategy: DeployStrategy },
) {
  for (const [name, output] of [
    ["UniversalVerifier", universalVerifierOutput],
    ["validators", validatorsOutput],
  ] as const) {
    if (output.chainId !== expected.chainId || output.network !== expected.networkName) {
      throw new Error(`${name} artifact chainId/network does not match selected network`);
    }
    if (output.deployStrategy && output.deployStrategy !== expected.strategy) {
      throw new Error(`${name} artifact deployStrategy does not match selected strategy`);
    }
  }
  if (!Array.isArray(validatorsOutput.validatorsInfo)) {
    throw new Error("validators artifact must contain validatorsInfo[]");
  }
  const proxies = new Map<string, string>();
  for (const entry of validatorsOutput.validatorsInfo) {
    const validator = validators.find((v) => v.type === entry.validatorType);
    if (!validator)
      throw new Error(`Unsupported validatorType in artifact: ${entry.validatorType}`);
    const proxy = address(entry.validator, entry.validatorType);
    if (proxies.has(validator.contract.name) && proxies.get(validator.contract.name) !== proxy) {
      throw new Error(`Conflicting legacy addresses for ${entry.validatorType}`);
    }
    proxies.set(validator.contract.name, proxy);
  }
  proxies.set(
    contractsInfo.UNIVERSAL_VERIFIER.name,
    address(universalVerifierOutput.universalVerifier, "UniversalVerifier artifact"),
  );
  return buildRegistration((contract) => proxies.get(contract.name));
}

export function loadValidatorRegistration(
  options: {
    source: RegistrationSource;
    strategy: DeployStrategy;
    chainId: number;
    networkName: string;
    deploymentId?: string;
    parameters?: Record<string, any>;
  },
  readJson: (filename: string) => Record<string, any> = (filename) =>
    JSON.parse(fs.readFileSync(filename, "utf8")),
): { registration: ValidatorRegistration; sourceDescription: string } {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  if (options.deploymentId !== undefined && options.source !== "ignition") {
    throw new Error("REGISTRATION_DEPLOYMENT_ID is only valid with REGISTRATION_SOURCE=ignition");
  }
  if (options.source === "params") {
    if (!options.parameters)
      throw new Error("Deployment parameters are required for params source");
    return {
      registration: registrationFromParameters(options.parameters, options.strategy),
      sourceDescription: `ignition/modules/params/chain-${options.chainId}.json (AtModule proxies)`,
    };
  }
  if (options.source === "legacy") {
    const outputDir = path.join(root, "scripts/deployments_output");
    const suffix = `${options.chainId}_${options.networkName}.json`;
    return {
      registration: registrationFromLegacy(
        readJson(path.join(outputDir, `deploy_universal_verifier_output_${suffix}`)),
        readJson(path.join(outputDir, `deploy_validators_output_${suffix}`)),
        options,
      ),
      sourceDescription: `${outputDir}/*_${suffix}`,
    };
  }
  if (options.source !== "ignition")
    throw new Error(`Unknown registration source: ${options.source}`);
  const deploymentId =
    options.deploymentId ??
    (options.strategy === "basic"
      ? `chain-${options.chainId}-simple-deploy-basic-strategy${options.chainId === 2401 ? "-london-v1" : ""}`
      : options.parameters?.DeploymentId || `chain-${options.chainId}`);
  if (
    !/^chain-\d+(?:[\w.-]*)$/.test(deploymentId) ||
    !new RegExp(`^chain-${options.chainId}(?:-|$)`).test(deploymentId)
  ) {
    throw new Error(`Invalid registry deployment ID for chain ${options.chainId}: ${deploymentId}`);
  }
  const registry = path.join(root, "ignition/deployments", deploymentId, "deployed_addresses.json");
  return {
    registration: registrationFromIgnition(readJson(registry)),
    sourceDescription: registry,
  };
}

function requireMatchingAuthMethod(expected: AuthRegistration, actual: AuthMethodData) {
  // The existing basic Ignition graph uses this dummy binding. embeddedAuth never
  // calls its validator; preserve that known legacy sentinel, but no arbitrary address.
  const legacyEmbedded =
    expected.authMethod === "embeddedAuth" &&
    address(actual.validator, expected.authMethod) ===
      contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress;
  if (
    (!legacyEmbedded && address(actual.validator, expected.authMethod) !== expected.validator) ||
    actual.params.toLowerCase() !== expected.params.toLowerCase()
  ) {
    throw new Error(
      `Auth method ${expected.authMethod} binding mismatch: expected validator=${expected.validator} params=${expected.params}; existing validator=${actual.validator} params=${actual.params}. Refusing to overwrite.`,
    );
  }
  if (!actual.isActive) {
    throw new Error(
      `Auth method ${expected.authMethod} is disabled; refusing to re-enable or report success`,
    );
  }
  return legacyEmbedded;
}

export async function registerValidators(options: {
  provider: AddressProvider;
  signer: Signer;
  verifier: RegistrationVerifier;
  registration: ValidatorRegistration;
  log?: (message: string) => void;
}) {
  const { provider, signer, verifier, registration, log = console.log } = options;
  const universalVerifier = address(registration.universalVerifier, "UniversalVerifier");
  if (address(await verifier.getAddress(), "Connected UniversalVerifier") !== universalVerifier) {
    throw new Error("Connected UniversalVerifier does not match selected deployment");
  }
  const requestValidators = registration.requestValidators.map((v) => ({
    ...v,
    address: address(v.address, v.name),
  }));
  const authMethods = registration.authMethods.map((v) => {
    if (typeof v.authMethod !== "string" || !v.authMethod.length) {
      throw new Error("authMethod must be a non-empty string");
    }
    if (!isHexString(v.params, true)) throw new Error(`Invalid bytes params for ${v.authMethod}`);
    return { ...v, validator: address(v.validator, v.authMethod) };
  });
  if (new Set(authMethods.map((v) => v.authMethod)).size !== authMethods.length) {
    throw new Error("Duplicate authMethod in registration input");
  }
  const addresses = new Set([
    universalVerifier,
    ...requestValidators.map((v) => v.address),
    ...authMethods.map((v) => v.validator),
  ]);
  // Complete address and binding preflight before sending even the first registration transaction.
  for (const proxy of addresses) {
    if ((await provider.getCode(proxy)) === "0x") {
      throw new Error(`No deployed code at ${proxy}; refusing all registration transactions`);
    }
  }
  const missingRequests: typeof requestValidators = [];
  const missingAuthMethods: AuthRegistration[] = [];
  for (const validator of requestValidators) {
    if (await verifier.isWhitelistedValidator(validator.address)) {
      log(`Already whitelisted: ${validator.name} (${validator.address})`);
    } else {
      missingRequests.push(validator);
    }
  }
  for (const method of authMethods) {
    if (await verifier.authMethodExists(method.authMethod)) {
      const existing = await verifier.getAuthMethod(method.authMethod);
      const legacyEmbedded = requireMatchingAuthMethod(method, existing);
      log(
        legacyEmbedded
          ? `Preserving legacy embeddedAuth placeholder ${existing.validator} (unused validator); params and active status match`
          : `Already configured correctly: ${method.authMethod} (${method.validator}, ${method.params})`,
      );
    } else {
      missingAuthMethods.push(method);
    }
  }
  if (missingRequests.length || missingAuthMethods.length) {
    const owner = address(await verifier.owner(), "UniversalVerifier owner");
    const signerAddress = address(await signer.getAddress(), "Signer");
    if (signerAddress !== owner) {
      throw new Error(
        `Signer ${signerAddress} is not UniversalVerifier owner ${owner}; missing configuration requires the owner`,
      );
    }
  }
  for (const validator of missingRequests) {
    await (await verifier.addValidatorToWhitelist(validator.address)).wait();
    if (!(await verifier.isWhitelistedValidator(validator.address))) {
      throw new Error(`Whitelist postcondition failed for ${validator.address}`);
    }
    log(`Whitelisted: ${validator.name} (${validator.address})`);
  }
  for (const method of missingAuthMethods) {
    await (await verifier.setAuthMethod(method)).wait();
    requireMatchingAuthMethod(method, await verifier.getAuthMethod(method.authMethod));
    log(`Registered: ${method.authMethod} (${method.validator}, ${method.params})`);
  }
  return { whitelisted: missingRequests.length, authMethodsAdded: missingAuthMethods.length };
}
