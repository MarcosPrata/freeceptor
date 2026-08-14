import { dump, load } from "js-yaml";

function isYamlFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

export function parseFileContent(raw: string, fileName: string): unknown {
  if (isYamlFile(fileName)) {
    try {
      return load(raw);
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Arquivo YAML inválido.",
      );
    }
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : "Arquivo JSON inválido.",
    );
  }
}

export function stringifyYaml(data: unknown): string {
  return dump(data, { lineWidth: 120, noRefs: true });
}
