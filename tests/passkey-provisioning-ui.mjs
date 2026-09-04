import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringToHex } from "viem";
import {
  connectRecoveryWallet,
  createProvisioningPasskey,
  signRecoveryAuthorizationWithWallet
} from "../lib/browser/wallet-intents.js";

const originalCredential = globalThis.PublicKeyCredential;
const originalNavigator = globalThis.navigator;
const originalSecureContext = globalThis.isSecureContext;
Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: class PublicKeyCredential {} });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: {} } });
Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });

const publicKey = `0x${"12".repeat(64)}`;
let creationOptions;
const passkey = await createProvisioningPasskey({
  name: "Marketplace rehearsal member",
  createCredential: async (options) => {
    creationOptions = options;
    return { id: "never-leaves-the-authenticator", publicKey, raw: { private: true } };
  }
});
assert.deepEqual(passkey, { publicKey }, "only the public key leaves browser passkey creation");
assert.equal(creationOptions.authenticatorSelection.residentKey, "required");
assert.equal(creationOptions.authenticatorSelection.requireResidentKey, true);
assert.equal(creationOptions.authenticatorSelection.userVerification, "required");
await assert.rejects(() => createProvisioningPasskey({
  createCredential: async () => ({ publicKey: "0x12" })
}), /P-256 public key/);

const recoveryAddress = "0x1111111111111111111111111111111111111111";
const providerCalls = [];
const provider = {
  async request(input) {
    providerCalls.push(input);
    if (input.method === "eth_requestAccounts") return [recoveryAddress];
    if (input.method === "eth_chainId") return "0xaa36a7";
    if (input.method === "personal_sign") return `0x${"34".repeat(65)}`;
    throw new Error("unexpected method");
  }
};
const recovery = await connectRecoveryWallet({ provider });
assert.equal(recovery.address, recoveryAddress);
assert.equal(recovery.chainId, 11155111);
const message = "Grove Safe recovery authorization\nChain ID: 11155111";
const signature = await signRecoveryAuthorizationWithWallet({ message, recoveryAddress, provider });
assert.match(signature, /^0x[0-9a-f]{130}$/);
assert.deepEqual(providerCalls.at(-1), {
  method: "personal_sign",
  params: [stringToHex(message), recoveryAddress]
});
await assert.rejects(() => connectRecoveryWallet({ provider: null }), /existing Ethereum wallet/);

Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: originalCredential });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: originalSecureContext });

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [app, css] = await Promise.all([
  readFile(join(root, "app.js"), "utf8"),
  readFile(join(root, "styles.css"), "utf8")
]);
assert.match(app, /configuration\.wallet\.environment === "sepolia-rehearsal"/,
  "the provisioning UI is gated to the public Sepolia rehearsal config");
assert.match(app, /curator\?\.status !== "active"/,
  "only an authenticated active curator can reveal provisioning");
assert.match(app, /const prepareBody = \{[\s\S]*stage: "prepare"/,
  "the browser supports direct passkey-only preparation");
assert.match(app, /if \(recoveryWalletAddress\)[\s\S]*stage: "challenge"[\s\S]*Object\.assign\(prepareBody/,
  "the browser proves optional recovery before adding it to preparation");
assert.match(app, /postWalletProvisioning\(\{ stage: "status" \}\)/,
  "the panel resumes prepared or active wallets without creating another passkey");
assert.match(app, /data-check-safe-activation/,
  "prepared wallets expose a clear deployment and finality check");
assert.doesNotMatch(app, /stage: "activate"/,
  "the browser cannot fabricate or submit deployment activation evidence");
assert.match(app, /It does not submit gas or claim that the Safe is active/,
  "the browser states its counterfactual boundary");
assert.match(app, /No injected wallet was found\. You can continue/,
  "Apple Pay users can create a passkey-only Safe without an existing wallet");
assert.match(app, /No recovery private key is generated or held/,
  "passkey-only creation does not invent a custodied recovery key");
assert.match(css, /\.wallet-provisioning__status/,
  "provisioning status uses the existing responsive visual system");

console.log("Passkey provisioning UI tests passed: passkey privacy, recovery proof, staging gate, and no browser activation.");
