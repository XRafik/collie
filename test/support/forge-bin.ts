#!/usr/bin/env bun
// The fake forge as a CLI, for the processes a test actually spawns; see forge.ts.

import { Schema } from "effect";
import { forgeBin } from "./forge";
import { runEffect } from "./effect";

const [forge = "", file = "", ...args] = Bun.argv.slice(2);
const { code, stdout } = await runEffect(
  forgeBin(Schema.decodeUnknownSync(Schema.Literals(["gitlab", "github"]))(forge), file, args),
);
if (stdout) await Bun.write(Bun.stdout, stdout);
globalThis.process.exitCode = code;
