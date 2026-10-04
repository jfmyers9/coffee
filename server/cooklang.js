import { readFile } from 'node:fs/promises';
import * as bindings from '@cooklang/cooklang/pkg/cooklang_wasm_bg.js';

// The pinned parser ships bundler-style WASM imports. Instantiate explicitly
// so Node 22+ needs neither a bundler nor experimental WASM module flags.
// 0.19.0's npm tarball omits the WASM files; keep 0.18.7 until that is fixed.
const bytes = await readFile(new URL('./pkg/cooklang_wasm_bg.wasm', import.meta.resolve('@cooklang/cooklang')));
const { instance } = await WebAssembly.instantiate(bytes, { './cooklang_wasm_bg.js': bindings });
bindings.__wbg_set_wasm(instance.exports);
export const parser = new bindings.Parser();
