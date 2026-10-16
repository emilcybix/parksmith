/**
 * Test support: appends a row to the file named by $RUN_MARGINS_OUT (nothing when it is unset). The app tsconfig has no node
 * types, so the built-ins are reached through process, like src/game/maps/generator/generator.crossprocess.test.ts.
 */
interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;
const { appendFileSync } = nodeProcess.getBuiltinModule('node:fs') as { appendFileSync(path: string, data: string): void };

export const noteMargin = (row: string): void => {
  const out = nodeProcess.env.RUN_MARGINS_OUT;
  if (out) appendFileSync(out, `${row}\n`);
};
