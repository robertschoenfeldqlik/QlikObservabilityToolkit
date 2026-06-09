// Manual roundtrip — verifies the OS keyring backend works end-to-end.
// Not part of `npm test` (which has to pass even when no keyring is available).
//   node --import tsx tests/_manual-keychain-roundtrip.mjs
import { saveCredentials, loadPat, snapshotCredentials, deleteCredentials } from "../src/credential-store.js";

const saved = await saveCredentials({ pat: "tcp_keychain_roundtrip_x", region: "us", storage: "keychain" });
console.log("saved:", saved);

const loaded = await loadPat();
console.log("loaded:", loaded);

const snap = await snapshotCredentials();
console.log("snap:", snap);

// Migrate back to file
const movedToFile = await saveCredentials({ pat: null, region: "us", storage: "file" });
console.log("moved to file:", movedToFile);

const loadedAfter = await loadPat();
console.log("loaded after migration:", loadedAfter);

await deleteCredentials();
console.log("cleanup done");
