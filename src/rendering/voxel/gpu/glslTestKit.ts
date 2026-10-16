/**
 * Test support for the GLSL the voxel programs are generated from: imported by the *.test.ts files
 * only (never by the renderer), so it lives next to them rather than in the shaders.
 */

/** Removes comments, then evaluates #ifdef / #ifndef / #else / #endif against #define lines. */
export const preprocessGlsl = (source: string): string => {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const defines = new Set<string>();
  const stack: { parentActive: boolean; taken: boolean }[] = [];
  const lines: string[] = [];
  let active = true;
  for (const line of uncommented.split('\n')) {
    const directive = /^\s*#\s*(ifdef|ifndef|else|endif|define)\b\s*(\w*)/.exec(line);
    if (!directive) {
      if (active) lines.push(line);
      continue;
    }
    const [, kind, name] = directive;
    if (kind === 'define') {
      if (active) defines.add(name);
    } else if (kind === 'ifdef' || kind === 'ifndef') {
      const taken = kind === 'ifdef' ? defines.has(name) : !defines.has(name);
      stack.push({ parentActive: active, taken });
      active = active && taken;
    } else if (kind === 'else') {
      const top = stack[stack.length - 1];
      active = top.parentActive && !top.taken;
    } else {
      const top = stack.pop();
      active = top?.parentActive ?? true;
    }
  }
  if (stack.length > 0) throw new Error('unbalanced #if blocks');
  return lines.join('\n');
};

