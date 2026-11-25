// ============================================================
// Shop-floor vocabulary shared by the golden-set generator and question parsing.
// ============================================================

/** Operation code (without OP_) → words an operator would use. */
export const OP_WORDS: Record<string, string> = {
  WELD: 'welding', CNC: 'CNC machining', COAT: 'coating', ELEC: 'electrical assembly', QA: 'quality inspection',
  PAINT: 'painting', MECH: 'mechanical assembly', ASSEMBLY: 'assembly', ASSEMBLE: 'assembly', CUT: 'cutting',
  BEND: 'bending', INSPECT: 'inspection', TEST: 'testing', PACK: 'packing',
};

/** OP_WELD → "welding"; unknown ops → the lowercase word. */
export const opWords = (op: string) => {
  const k = op.replace(/^OP_/, '').toUpperCase();
  return OP_WORDS[k] ?? k.toLowerCase().replace(/_/g, ' ');
};

/**
 * Operation codes named in free text ("the welding station" → OP_WELD). Longest phrases first, so
 * "mechanical assembly" is not also read as "assembly"; extra stems catch "weld", "coated", "QA".
 */
export function opsInText(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  let rest = t;
  const phrases = Object.entries(OP_WORDS).sort((a, b) => b[1].length - a[1].length);
  for (const [code, words] of phrases) {
    if (rest.includes(words.toLowerCase())) { found.add(`OP_${code}`); rest = rest.split(words.toLowerCase()).join(' '); }
  }
  const stems: Array<[RegExp, string]> = [[/\bweld/, 'OP_WELD'], [/\bcnc\b|\bmachining\b/, 'OP_CNC'], [/\bcoat/, 'OP_COAT'], [/\bqa\b|\bquality\b/, 'OP_QA'], [/\belectrical\b/, 'OP_ELEC']];
  for (const [re, code] of stems) if (re.test(rest)) found.add(code);
  return [...found].sort();
}
