import { getAddress, isHex, keccak256, stringToHex } from "viem";

export const USER_OPERATION_FIELDS = [
  "sender", "nonce", "factory", "factoryData", "callData", "callGasLimit",
  "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas",
  "paymaster", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterData"
];
const NUMERIC_FIELDS = new Set([
  "nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas",
  "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"
]);
const ADDRESS_FIELDS = new Set(["sender", "factory", "paymaster"]);

const quantity = (input, { positive = false } = {}) => {
  let output;
  try {
    output = typeof input === "bigint" ? input : BigInt(input);
  } catch {
    throw new Error("INVALID_USER_OPERATION");
  }
  if (output < 0n || (positive && output === 0n)) throw new Error("INVALID_USER_OPERATION");
  return output;
};

export const normalizeUserOperation = (input, { signature = false } = {}) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_USER_OPERATION");
  const output = {};
  for (const field of USER_OPERATION_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (ADDRESS_FIELDS.has(field)) output[field] = getAddress(value);
    else if (NUMERIC_FIELDS.has(field)) output[field] = quantity(value, { positive: field !== "nonce" });
    else {
      if (!isHex(value)) throw new Error("INVALID_USER_OPERATION");
      output[field] = value.toLowerCase();
    }
  }
  if (!output.sender || output.nonce === undefined || !output.callData
    || output.callGasLimit === undefined || output.verificationGasLimit === undefined
    || output.preVerificationGas === undefined || output.maxFeePerGas === undefined
    || output.maxPriorityFeePerGas === undefined || output.maxPriorityFeePerGas > output.maxFeePerGas
    || Boolean(output.factory) !== Boolean(output.factoryData)
    || Boolean(output.paymaster) !== Boolean(output.paymasterData)
    || (output.paymaster && (output.paymasterVerificationGasLimit === undefined || output.paymasterPostOpGasLimit === undefined))) {
    throw new Error("INVALID_USER_OPERATION");
  }
  if (signature) {
    if (!isHex(input.signature) || input.signature.length < 26 || input.signature.length > 16_386) throw new Error("INVALID_USER_OPERATION_SIGNATURE");
    output.signature = input.signature.toLowerCase();
  }
  return output;
};

export const userOperationToJson = (input, { signature = false } = {}) => {
  const operation = normalizeUserOperation(input, { signature });
  return Object.fromEntries(Object.entries(operation).map(([key, value]) => [key, typeof value === "bigint" ? `0x${value.toString(16)}` : value]));
};

export const userOperationCommitment = (input) => keccak256(stringToHex(JSON.stringify(userOperationToJson(input))));

export const maximumSponsoredCost = (input) => {
  const operation = normalizeUserOperation(input);
  const totalGas = operation.callGasLimit + operation.verificationGasLimit + operation.preVerificationGas
    + (operation.paymasterVerificationGasLimit || 0n) + (operation.paymasterPostOpGasLimit || 0n);
  return totalGas * operation.maxFeePerGas;
};

export const assertUserOperationSignatureWindow = ({ signature, validAfter = 0, validUntil }) => {
  if (!isHex(signature) || signature.length < 26) throw new Error("INVALID_USER_OPERATION_SIGNATURE");
  const expected = `${BigInt(validAfter).toString(16).padStart(12, "0")}${BigInt(validUntil).toString(16).padStart(12, "0")}`;
  if (signature.slice(2, 26).toLowerCase() !== expected) throw new Error("USER_OPERATION_VALIDITY_CHANGED");
};
