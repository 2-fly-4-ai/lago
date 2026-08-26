import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const fixtureDirectory = resolve(packageDirectory, "fixtures/documents");
const temporaryRoot = resolve(packageDirectory, "tmp/pdfs");
const mode = process.argv.includes("--update") ? "update" : "check";
const chrome = findExecutable(
  process.env.PDF_GOLDEN_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "google-chrome",
  "chromium",
  "chromium-browser",
);
const pdftoppm = findExecutable(process.env.PDF_GOLDEN_PDFTOPPM, "pdftoppm");
const python = findExecutable(process.env.PDF_GOLDEN_PYTHON, "python3");
const esbuild = findEsbuild();

mkdirSync(temporaryRoot, { recursive: true });
const workingDirectory = mkdtempSync(join(temporaryRoot, "run-"));

try {
  const bundle = join(workingDirectory, "document-golden-html.mjs");
  execFileSync(esbuild, [
    resolve(scriptDirectory, "document-golden-html.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundle}`,
  ]);
  const cases = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8" }));
  const documents = [];
  for (const documentCase of cases) {
    const htmlPath = join(workingDirectory, `${documentCase.name}.html`);
    const pdfPath = join(workingDirectory, `${documentCase.name}.pdf`);
    writeFileSync(htmlPath, documentCase.html);
    const chromeResult = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-background-mode",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pdf-header-footer",
        `--user-data-dir=${join(workingDirectory, `chrome-${documentCase.name}`)}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { env: chromeEnvironment(), maxBuffer: 8 * 1024 * 1024 },
    );
    if (chromeResult.error || !validPdfFile(pdfPath)) {
      const detail = chromeResult.stderr?.toString().slice(-2_000) || "no PDF was written";
      throw new Error(`${documentCase.name} Chrome render failed: ${detail}`);
    }
    if (readFileSync(pdfPath).includes(Buffer.from("/Subtype /Type3"))) {
      throw new Error(`${documentCase.name} contains non-portable Type 3 fonts`);
    }
    execFileSync(pdftoppm, [
      "-r",
      "300",
      "-png",
      pdfPath,
      join(workingDirectory, documentCase.name),
    ]);
    const structure = inspectPdf(pdfPath, documentCase.expectedText);
    if (structure.pageCount < documentCase.minimumPages) {
      throw new Error(
        `${documentCase.name} rendered ${structure.pageCount} pages; expected at least ${documentCase.minimumPages}`,
      );
    }
    if (structure.outOfBoundsCharacters !== 0) {
      throw new Error(
        `${documentCase.name} has ${structure.outOfBoundsCharacters} out-of-bounds characters`,
      );
    }
    const pages = Array.from({ length: structure.pageCount }, (_, index) => {
      const filename = `${documentCase.name}-${index + 1}.png`;
      const path = join(workingDirectory, filename);
      const dimensions = pngDimensions(readFileSync(path));
      return { filename, sha256: sha256(path), ...dimensions };
    });
    documents.push({
      name: documentCase.name,
      htmlSha256: sha256Bytes(Buffer.from(documentCase.html)),
      pdfSha256: sha256(pdfPath),
      pageCount: structure.pageCount,
      pageWidthPoints: structure.pageWidthPoints,
      pageHeightPoints: structure.pageHeightPoints,
      extractedTextSha256: structure.extractedTextSha256,
      extractedCharacterCount: structure.extractedCharacterCount,
      outOfBoundsCharacters: structure.outOfBoundsCharacters,
      expectedText: documentCase.expectedText,
      rowCount: documentCase.rowCount,
      pages,
    });
  }
  const manifest = { schemaVersion: 1, renderer: "Chrome headless + Poppler 300 DPI", documents };
  if (mode === "update") {
    mkdirSync(fixtureDirectory, { recursive: true });
    for (const entry of readdirSync(fixtureDirectory)) {
      if (/^(?:invoice|payment-receipt|credit-note)(?:-\d+)?\.(?:pdf|png)$/.test(entry)) {
        rmSync(join(fixtureDirectory, entry));
      }
    }
    for (const document of documents) {
      copyFileSync(
        join(workingDirectory, `${document.name}.pdf`),
        join(fixtureDirectory, `${document.name}.pdf`),
      );
      for (const page of document.pages) {
        copyFileSync(join(workingDirectory, page.filename), join(fixtureDirectory, page.filename));
      }
    }
    writeFileSync(
      join(fixtureDirectory, "document-goldens.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    process.stdout.write(`Updated ${documents.length} document goldens\n`);
  } else {
    const expected = JSON.parse(
      readFileSync(join(fixtureDirectory, "document-goldens.json"), "utf8"),
    );
    const comparable = (value) => ({
      ...value,
      documents: value.documents.map(({ pdfSha256: _pdfSha256, ...document }) => document),
    });
    if (JSON.stringify(comparable(manifest)) !== JSON.stringify(comparable(expected))) {
      throw new Error(
        "Document goldens changed; run documents:golden:update and inspect every PNG",
      );
    }
    process.stdout.write(`Verified ${documents.length} document goldens\n`);
  }
} finally {
  rmSync(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function inspectPdf(pdfPath, expectedText) {
  const source = `
import hashlib, json, logging, re, sys
from pypdf import PdfReader
import pdfplumber

logging.getLogger("pypdf").setLevel(logging.ERROR)
path = sys.argv[1]
expected = json.loads(sys.argv[2])
reader = PdfReader(path)
text = " ".join((page.extract_text() or "") for page in reader.pages)
normalized = re.sub(r"\\s+", " ", text).strip()
missing = [token for token in expected if token not in normalized]
if missing:
    raise SystemExit("missing PDF text: " + json.dumps(missing))
out_of_bounds = 0
with pdfplumber.open(path) as pdf:
    for page in pdf.pages:
        for char in page.chars:
            if char["x0"] < -0.5 or char["x1"] > page.width + 0.5 or char["top"] < -0.5 or char["bottom"] > page.height + 0.5:
                out_of_bounds += 1
box = reader.pages[0].mediabox
print(json.dumps({
    "pageCount": len(reader.pages),
    "pageWidthPoints": round(float(box.width), 2),
    "pageHeightPoints": round(float(box.height), 2),
    "extractedTextSha256": hashlib.sha256(normalized.encode()).hexdigest(),
    "extractedCharacterCount": len(normalized),
    "outOfBoundsCharacters": out_of_bounds,
}))
`;
  return JSON.parse(
    execFileSync(python, ["-c", source, pdfPath, JSON.stringify(expectedText)], {
      encoding: "utf8",
    }),
  );
}

function findEsbuild() {
  const pnpmDirectory = resolve(packageDirectory, "node_modules/.pnpm");
  const packageName = readdirSync(pnpmDirectory)
    .filter((entry) => entry.startsWith("esbuild@"))
    .sort()
    .at(-1);
  if (!packageName) throw new Error("esbuild is not installed");
  return resolve(pnpmDirectory, packageName, "node_modules/esbuild/bin/esbuild");
}

function findExecutable(...candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    if (!candidate.includes("/")) {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      if (!result.error) return candidate;
    }
  }
  throw new Error(`Required executable is unavailable: ${candidates.filter(Boolean).join(", ")}`);
}

function chromeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "MallocNanoZone"),
  );
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes) {
  if (bytes.subarray(1, 4).toString("ascii") !== "PNG") throw new Error("invalid PNG fixture");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validPdfFile(path) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return bytes.length > 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}
