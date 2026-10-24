import type { z } from "zod";

function unwrap(schema: z.ZodType): z.ZodType {
  let s: any = schema;
  for (let i = 0; i < 5 && s && (s._zod?.def?.innerType || s.def?.innerType); i++) s = s._zod?.def?.innerType ?? s.def?.innerType;
  return s as z.ZodType;
}

function kindOf(schema: z.ZodType): "number" | "boolean" | "array" | "string" {
  const inner: any = unwrap(schema);
  const type: string | undefined = inner?._zod?.def?.type ?? inner?.def?.type;
  if (type === "number" || type === "int") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  return "string";
}

/** Maps `--flag value` pairs onto a tool's zod input shape (numbers, booleans, repeated arrays). */
export function parseArgs(argv: string[], shape: Record<string, z.ZodType>): { args: Record<string, unknown>; json: boolean; root?: string } {
  const args: Record<string, unknown> = {};
  let json = false;
  let root: string | undefined;
  const keys = new Map(Object.keys(shape).map((k) => [k.toLowerCase(), k]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (!a.startsWith("--")) throw new Error(`Unexpected argument "${a}"`);
    const [flag, inlineValue] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    let value = inlineValue;
    if (flag === "root") {
      root = value ?? argv[++i];
      continue;
    }
    const key = keys.get(flag.replace(/-/g, "").toLowerCase()) ?? keys.get(flag.toLowerCase());
    if (!key) throw new Error(`Unknown option --${flag}`);
    const kind = kindOf(shape[key]!);
    if (kind === "boolean") {
      args[key] = value === undefined ? true : !/^(false|0|no)$/i.test(value);
      continue;
    }
    value ??= argv[++i];
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    if (kind === "number") args[key] = Number(value);
    else if (kind === "array") args[key] = [...((args[key] as unknown[]) ?? []), value];
    else args[key] = value;
  }
  return { args, json, root };
}

