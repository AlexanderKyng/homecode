import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../openqcode && bun script/build-node.ts`
