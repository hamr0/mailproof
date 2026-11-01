// Adopter-visible declaration check on the GENERATED .d.ts (LIBRARY_CONVENTIONS
// section 5, "assert a PROPERTY of the whole surface"). Rule: no exported
// function, or method of an exported class, returns a bare `object` -- it
// accepts no property access, so an adopter cannot read a field off it.
// (The parity rule does not apply: mailproof has one implementation of its API.)
//
//   node scripts/check-types.mjs [typesDir]     needs `npm run build:types` first
//
// Exit 0 = clean, 1 = findings, 2 = declarations were never built (so a
// misconfigured step cannot look like a pass).
import ts from 'typescript';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const typesDir = resolve(process.argv[2] ?? 'types');
const entry = resolve(typesDir, 'index.d.ts');
if (!existsSync(entry)) {
  console.error(`missing ${entry} -- run \`npm run build:types\` first.`);
  process.exit(2);
}

const program = ts.createProgram([entry], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const root = program.getSourceFile(entry);
const mod = root && checker.getSymbolAtLocation(root);
// Root re-exports are alias symbols; resolve them to the real declarations.
const exported = (mod ? checker.getExportsOfModule(mod) : []).map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s));

const isBareObject = (ty) => (ty.isUnion() ? ty.types : [ty]).some((p) => checker.typeToString(p) === 'object');
const callSig = (sym) => {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  return decl ? checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(sym, decl), ts.SignatureKind.Call)[0] ?? null : null;
};
const findings = [];
const inspect = (where, sym) => {
  const sig = callSig(sym);
  if (!sig) return;
  const ret = checker.getReturnTypeOfSignature(sig);
  if (isBareObject(ret) || isBareObject(checker.getAwaitedType?.(ret) ?? ret)) findings.push(where);
};

let checked = 0;
for (const sym of exported) {
  inspect(`${sym.getName()}()`, sym);
  checked++;
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl && ts.isClassDeclaration(decl)) {
    const inst = checker.getDeclaredTypeOfSymbol(sym);
    for (const m of inst.getProperties()) { inspect(`${sym.getName()}#${m.getName()}()`, m); checked++; }
  }
}
for (const f of findings) console.log(`bare-object: ${f} returns a bare \`object\`; annotate the real shape or drop the @returns and let tsc infer it.`);
if (findings.length) { console.log(`${findings.length} adopter-visible declaration defect(s).`); process.exit(1); }
console.log(`adopter-visible declarations OK (bare-object) -- ${checked} exported members checked.`);
