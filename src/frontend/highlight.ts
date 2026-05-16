/**
 * Syntax highlighting using highlight.js.
 * Maps file extensions to hljs language IDs and provides
 * per-line highlighting for diff and full-file views.
 */

import hljs from "highlight.js/lib/core";

// Register only the languages we need (tree-shakeable)
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import shell from "highlight.js/lib/languages/shell";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);

// Aliases for common extensions
hljs.registerAliases("js", { languageName: "javascript" });
hljs.registerAliases("jsx", { languageName: "javascript" });
hljs.registerAliases("ts", { languageName: "typescript" });
hljs.registerAliases("tsx", { languageName: "typescript" });
hljs.registerAliases("py", { languageName: "python" });
hljs.registerAliases("sh", { languageName: "bash" });
hljs.registerAliases("html", { languageName: "xml" });
hljs.registerAliases("htm", { languageName: "xml" });
hljs.registerAliases("rs", { languageName: "rust" });
hljs.registerAliases("rb", { languageName: "ruby" });
hljs.registerAliases("yml", { languageName: "yaml" });
hljs.registerAliases("md", { languageName: "markdown" });
hljs.registerAliases("cs", { languageName: "csharp" });

/**
 * Map a file extension (with or without leading dot) to an hljs language ID.
 * Returns undefined if no mapping is found (caller should skip highlighting).
 */
function extensionToLang(ext: string): string | undefined {
  const cleaned = ext.replace(/^\./, "").toLowerCase();
  const direct: Record<string, string> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    py: "python", pyi: "python", pyx: "python",
    sh: "bash", bash: "bash", zsh: "bash",
    json: "json", jsonc: "json",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    css: "css", scss: "css", less: "css",
    sql: "sql",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c", h: "c",
    cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    yml: "yaml", yaml: "yaml",
    md: "markdown", markdown: "markdown",
    txt: "plaintext",
    toml: "ini",
    ini: "ini", cfg: "ini", conf: "ini",
    makefile: "makefile",
    dockerfile: "dockerfile",
  };
  return direct[cleaned];
}

/**
 * Extract a file extension from a path string.
 */
function getExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx === -1) return base.toLowerCase(); // e.g. "Makefile", "Dockerfile"
  return base.slice(dotIdx + 1).toLowerCase();
}

/**
 * Highlight a single line of code.
 * Returns an HTML string with <span class="hljs-*"> tags, or the
 * original text escaped if the language is unsupported.
 *
 * @param line - The raw line content (already HTML-escaped by caller).
 * @param filePath - Used to determine the language from the extension.
 * @returns HTML string with highlighting spans, or empty string for empty lines.
 */
export function highlightLine(line: string, filePath?: string): string {
  if (!filePath) return "";
  const ext = getExtension(filePath);
  const lang = extensionToLang(ext);
  if (!lang || !line) return "";

  try {
    const result = hljs.highlight(line, { language: lang });
    return result.value;
  } catch {
    return "";
  }
}

/**
 * Highlight a multi-line code block.
 * @returns HTML string with hljs spans, or empty string if unsupported.
 */
export function highlightBlock(code: string, filePath?: string): string {
  if (!filePath || !code) return "";
  const ext = getExtension(filePath);
  const lang = extensionToLang(ext);
  if (!lang) return "";

  try {
    const result = hljs.highlight(code, { language: lang });
    return result.value;
  } catch {
    return "";
  }
}
