# Third-party notices

This application uses open-source components under their respective licenses.
The production dependency set is exact-pinned in `package-lock.json`; bundled
license comments are retained in the browser artifact. Every release build also
generates `dist/THIRD_PARTY_NOTICES.txt` from the esbuild metafile and copies the
full license text for every package that contributes browser code. The build
fails if any contributing package lacks a distributable license file.

- Stripe Node.js — MIT: https://github.com/stripe/stripe-node
- Supabase JavaScript — MIT: https://github.com/supabase/supabase-js
- viem — MIT: https://github.com/wevm/viem
- permissionless.js — MIT: https://github.com/pimlicolabs/permissionless.js
- ox — MIT: https://github.com/wevm/ox
- @noble/hashes — MIT: https://github.com/paulmillr/noble-hashes
- OpenSea Seaport.js — MIT: https://github.com/ProjectOpenSea/seaport-js
- OpenSea API Types — MIT: https://github.com/ProjectOpenSea/api-types
- OpenZeppelin Contracts — MIT: https://github.com/OpenZeppelin/openzeppelin-contracts
- Forge Standard Library — MIT or Apache-2.0: https://github.com/foundry-rs/forge-std

Source distributions and complete license texts remain available from the
linked upstream projects and installed package metadata.

The reviewed exact license copy for `@opensea/seaport-js` 4.3.0 is retained in
`third_party_licenses/` because it is part of the secondary-market conformance
boundary. OpenSea publication uses its documented server API directly so the
API key and publisher remain isolated from browser/request bundles.
