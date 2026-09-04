import { getAddress, isHex, numberToHex } from "viem";
import { maximumSponsoredCost, normalizeUserOperation, userOperationToJson } from "../shared/sponsored-userop.js";

const rpc = async ({ url, token, method, params }) => {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error("USER_OPERATION_PROVIDER_UNAVAILABLE");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("USER_OPERATION_PROVIDER_INVALID_RESPONSE");
  }
  if (!response.ok || body?.error || !("result" in (body || {}))) {
    const error = new Error("USER_OPERATION_PROVIDER_REJECTED");
    error.providerCode = typeof body?.error?.code === "number" ? body.error.code : null;
    throw error;
  }
  return body.result;
};

const bigint = (input, { positive = false } = {}) => {
  let value;
  try {
    value = BigInt(input);
  } catch {
    throw new Error("USER_OPERATION_PROVIDER_INVALID_RESPONSE");
  }
  if (value < 0n || (positive && value === 0n)) throw new Error("USER_OPERATION_PROVIDER_INVALID_RESPONSE");
  return value;
};

const paymasterFields = (input) => {
  if (!input || input.paymasterAndData || !input.paymaster || !input.paymasterData
    || !isHex(input.paymasterData)) throw new Error("USER_OPERATION_PROVIDER_INVALID_RESPONSE");
  return {
    paymaster: getAddress(input.paymaster),
    paymasterData: input.paymasterData.toLowerCase(),
    paymasterVerificationGasLimit: bigint(input.paymasterVerificationGasLimit, { positive: true }),
    paymasterPostOpGasLimit: bigint(input.paymasterPostOpGasLimit, { positive: true })
  };
};

const gasFields = (input) => {
  if (!input) throw new Error("USER_OPERATION_PROVIDER_INVALID_RESPONSE");
  return {
    callGasLimit: bigint(input.callGasLimit, { positive: true }),
    verificationGasLimit: bigint(input.verificationGasLimit, { positive: true }),
    preVerificationGas: bigint(input.preVerificationGas, { positive: true })
  };
};

export const createStandardUserOperationProvider = ({ config }) => ({
  name: "standard-erc4337-erc7677",
  async getPaymasterStubData(operation, context) {
    return rpc({
      url: config.wallet.paymasterUrl,
      token: config.wallet.paymasterApiToken,
      method: "pm_getPaymasterStubData",
      params: [
        userOperationToJson(operation, { signature: true }),
        config.wallet.entryPointAddress,
        numberToHex(config.wallet.chainId),
        context
      ]
    });
  },
  async getPaymasterData(operation, context) {
    return rpc({
      url: config.wallet.paymasterUrl,
      token: config.wallet.paymasterApiToken,
      method: "pm_getPaymasterData",
      params: [
        userOperationToJson(operation, { signature: true }),
        config.wallet.entryPointAddress,
        numberToHex(config.wallet.chainId),
        context
      ]
    });
  },
  async estimateUserOperationGas(operation) {
    return rpc({
      url: config.wallet.bundlerUrl,
      method: "eth_estimateUserOperationGas",
      params: [userOperationToJson(operation, { signature: true }), config.wallet.entryPointAddress]
    });
  },
  async sendUserOperation(operation) {
    return rpc({
      url: config.wallet.bundlerUrl,
      method: "eth_sendUserOperation",
      params: [userOperationToJson(operation, { signature: true }), config.wallet.entryPointAddress]
    });
  },
  async getUserOperationReceipt(hash) {
    return rpc({ url: config.wallet.bundlerUrl, method: "eth_getUserOperationReceipt", params: [hash] });
  }
});

export const prepareProviderSponsoredOperation = async ({
  config, provider, safeAccount, callData, paymasterContext, fees
}) => {
  const [nonce, stubSignature] = await Promise.all([safeAccount.getNonce(), safeAccount.getStubSignature()]);
  const feeValues = fees || await safeAccount.client.estimateFeesPerGas();
  const maxFeePerGas = bigint(feeValues.maxFeePerGas, { positive: true });
  const maxPriorityFeePerGas = bigint(feeValues.maxPriorityFeePerGas, { positive: true });
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error("USER_OPERATION_FEE_REJECTED");
  let operation = {
    sender: getAddress(await safeAccount.getAddress()),
    nonce: bigint(nonce),
    callData,
    callGasLimit: 1n,
    verificationGasLimit: 1n,
    preVerificationGas: 1n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: stubSignature
  };
  operation = { ...operation, ...paymasterFields(await provider.getPaymasterStubData(operation, paymasterContext)) };
  operation = { ...operation, ...gasFields(await provider.estimateUserOperationGas(operation)) };
  operation = { ...operation, ...paymasterFields(await provider.getPaymasterData(operation, paymasterContext)) };
  // The final paymaster payload is simulated without accepting replacement gas
  // fields, because changing signed quote fields after sponsorship is unsafe.
  await provider.estimateUserOperationGas(operation);
  const unsigned = normalizeUserOperation(operation);
  return { operation: unsigned, quotedCostWei: maximumSponsoredCost(unsigned), provider: provider.name };
};
