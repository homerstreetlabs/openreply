# eslint-plugin-anti-slop

Opinionated ESLint rules that reject low-evidence and low-signal TypeScript and JavaScript patterns.

This is an ESLint port of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), which ships the same rules for Oxlint. The rule logic, messages, and test cases are carried over one to one; what changed is the host linter, so the rules run in any project that already runs ESLint, with no second linter to install.

Like the original, this is meant to be **vendored, not pinned**. Copy it into your repository, read the rules, and change them to match your team's standards. The `deslop` skill installs and configures it for you; after that the copied files are yours.

## What it needs

- ESLint 9 with flat config
- `@typescript-eslint/parser` on your `.ts` / `.tsx` files

No type information. Every rule is syntactic, so there is no `parserOptions.project`, no type-aware lint pass, and no measurable slowdown on a large repository.

The plugin is plain ESM JavaScript on purpose. It loads unchanged from `eslint.config.js`, `.mjs`, and `.ts` configs, with no build step and no TypeScript loader.

## Install

```bash
npm install --save-dev eslint-plugin-anti-slop
```

Or vendor it: copy this directory to `tools/eslint/anti-slop/` and import it by relative path.

## Configure

```js
// eslint.config.mjs
import tsParser from "@typescript-eslint/parser";
import antiSlop from "eslint-plugin-anti-slop";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
  },
  { files: ["**/*.ts", "**/*.tsx"], ...antiSlop.configs.recommended },
];
```

Two configs ship:

| Config | What it does |
|---|---|
| `recommended` | Every rule at `error`. |
| `starter` | The same, with `no-runtime-typeof` off and `require-safety-comment-for-type-assertion` at `warn`. Those two fire on a lot of existing code, so a repository adopting anti-slop mid-life usually starts here and tightens later. |

Both configs register the plugin themselves. Spread one after whichever config already points `.ts` files at the TypeScript parser.

Exclude your agent directories and the vendored copy so the plugin does not lint itself or the assets your coding agent installed:

```js
{ ignores: [".claude/**", ".cursor/**", ".codex/**", "tools/eslint/anti-slop/**"] }
```

### Optional Effect rules

Effect-specific rules live in a separate entry point so projects that do not use Effect do not inherit Effect architecture policy:

```js
import antiSlopEffect from "eslint-plugin-anti-slop/effect";

export default [
  // ...
  { files: ["**/*.ts"], ...antiSlopEffect.configs.recommended },
];
```

## Rules

### Generic

| Rule | Rejects |
|---|---|
| `no-chained-type-assertions` | Nested type assertions that fabricate evidence. |
| `no-conditional-empty-object-spread` | Conditional spreads that use `{}` to omit fields. |
| `no-known-value-widening` | Explicit broad target types that discard known value evidence. |
| `no-module-mocking` | Vitest and Jest module mocks, in favor of real dependency seams. |
| `no-object-parameters` | The broad `object` type on function inputs. |
| `no-reflect-apply` | `Reflect.apply`, in favor of typed function calls. |
| `no-reflect-get` | `Reflect.get`, in favor of typed property access or boundary parsing. |
| `no-runtime-typeof` | Ad hoc `typeof` narrowing instead of boundary parsing. |
| `no-shape-in-symbol-names` | `shape` in symbol names. |
| `no-unknown-parameters` | `unknown` inputs, except the explicit `cause` convention. |
| `no-unknown-returns` | Function contracts that return `unknown` or `Promise<unknown>`. |
| `no-unknown-type-aliases` | Aliases that merely conceal `unknown`. |
| `no-unsafe-dictionary-type` | Dictionary value contracts built on `unknown`, `any`, `object`, `{}`, and equivalents. |
| `no-widen-then-assert` | Local flows that widen known values and later assert them back. |
| `require-safety-comment-for-type-assertion` | Non-const assertions with no documented invariant. |

### Effect

| Rule | Rejects |
|---|---|
| `no-service-constructor-imports` | Relative project imports of exported `make<CapabilityName>` constructors outside `*.test.*` and `*.spec.*` files. Import the owning Layer and yield the contextual service instead. |

## Options

`no-runtime-typeof` takes one option. Schema-free projects can permit `typeof` inside type predicate and assertion functions while still rejecting ad hoc checks elsewhere:

```js
"anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }]
```

It defaults to `false`.

## Violation examples

```ts
const user = input as object as User;                        // no-chained-type-assertions
const options = { ...(timeout !== undefined ? { timeout } : {}) };  // no-conditional-empty-object-spread
const handlers: Record<string, Handler> = { start: startHandler };  // no-known-value-widening
vi.mock("./user-store");                                     // no-module-mocking
function save(value: object) {}                              // no-object-parameters
Reflect.apply(operation, owner, args);                       // no-reflect-apply
Reflect.get(owner, key);                                     // no-reflect-get
if (typeof input === "string") useName(input);               // no-runtime-typeof
interface UserShape { id: string }                           // no-shape-in-symbol-names
function handle(input: unknown) {}                           // no-unknown-parameters
function loadUser(): unknown { return input; }               // no-unknown-returns
type ExternalValue = unknown;                                // no-unknown-type-aliases
type Metadata = Record<string, unknown>;                     // no-unsafe-dictionary-type
const userId = value as UserId;                              // require-safety-comment-for-type-assertion
```

`no-known-value-widening` fires on the handlers example because the annotation throws away the known `start` key. Preserve inference, or write `satisfies Record<string, Handler>`.

`require-safety-comment-for-type-assertion` is satisfied by a specific justification immediately before the assertion or its containing statement:

```ts
// SAFETY: parseUserId validated the identifier before branding it.
const userId = value as UserId;
```

## Differences from the Oxlint original

The rules behave identically. Three things are different by necessity:

- Oxlint exposes `sourceCode.isGlobalReference`. ESLint does not, so `src/shared/scope.js` rebuilds it from scope analysis: a name with no resolvable binding, or one whose only binding has no definition site, is global.
- Oxlint nodes carry `start` / `end`. typescript-eslint nodes carry `range`, so position reads go through the `start()` / `end()` helpers in `src/shared/ast.js`.
- typescript-eslint drops `ParenthesizedExpression` and `TSParenthesizedType` from the tree. The unwrap loops that handle them are kept as no-ops, because a parser configured with `preserveParens` would reintroduce them and a rule that silently stops firing is worse than three cheap comparisons.

`src/shared/ast.js` also reads `TSMappedType` in both the v7 (`typeParameter`) and v8 (`key` + `constraint`) shapes, so the plugin works across typescript-eslint majors.

## Development

```bash
npm install
npm test
```

226 tests, ported from the original's rule tests and run through ESLint's `RuleTester` against `@typescript-eslint/parser`.

## License

MIT. Original rules © Dillon Mulroy, [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).
