import { pathToFileURL } from "node:url";

const ORIGIN = "https://sst.streamlinedsalestax.org";
const text = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

// Evidence only. Numeric matrix answers are retained, never interpreted as rates.
export function extractSoftwareRows(rows) {
  if (!Array.isArray(rows)) throw new Error("Invalid matrix rows");
  return rows.flatMap((row) => {
    if (!Array.isArray(row.displayColumns)) throw new Error("Invalid matrix columns");
    const columns = [...row.displayColumns].sort((a, b) => a.orderId - b.orderId);
    const reference = text(columns[0]?.tValue);
    if (!/^30\d{3}$/.test(reference)) return [];
    const label = text(columns[1]?.tValue);
    if (!/software/i.test(label)) return [];
    return [
      {
        reference,
        label,
        cells: columns.slice(2).map((column) => ({
          order: column.orderId,
          validation_type: column.validationTypeId,
          answer: text(column.value),
          template: text(column.tValue),
        })),
      },
    ];
  });
}

export function latestPublished(versions, stateId) {
  if (!Array.isArray(versions)) throw new Error("Invalid versions");
  const published = versions.filter(
    (v) =>
      v.published === true &&
      v.stateId === stateId &&
      v.formTypeId === 1 &&
      Number.isSafeInteger(v.formId) &&
      v.formId > 0 &&
      Number.isFinite(v.version),
  );
  published.sort((a, b) => b.version - a.version);
  if (!published.length || (published[1] && published[0].version === published[1].version))
    throw new Error("Missing or ambiguous published matrix");
  return published[0];
}

async function get(path) {
  const response = await fetch(ORIGIN + path, {
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Public matrix request failed: ${response.status}`);
  const body = await response.text();
  if (body.length > 12000000) throw new Error("Matrix response exceeds evidence limit");
  return JSON.parse(body);
}

export async function collectSoftwareReview() {
  const states = await get("/api/states");
  if (!Array.isArray(states)) throw new Error("Invalid public state list");
  const eligible = states.filter(
    (s) =>
      s.stateId > 0 && /^[A-Z]{2}$/.test(s.abbreviation) && s.formTypeIdsWithVersions?.includes(1),
  );
  const results = [];
  // Three independent public reads at a time, not fifty parallel requests.
  for (let offset = 0; offset < eligible.length; offset += 3) {
    results.push(
      ...(await Promise.all(
        eligible.slice(offset, offset + 3).map(async (state) => {
          const version = latestPublished(
            await get(`/api/forms/State/${state.stateId}/FormType/1/Versions`),
            state.stateId,
          );
          const path = `/api/forms/${version.formId}/rows`;
          const rows = extractSoftwareRows(await get(path));
          if (!rows.some((row) => row.reference === "30050"))
            throw new Error(`Downloaded software row missing: ${state.abbreviation}`);
          return {
            region: state.abbreviation,
            version: version.version,
            form_id: version.formId,
            source_url: ORIGIN + path,
            rows,
            rate_coverage: "not_assessed",
            activation_allowed: false,
          };
        }),
      )),
    );
  }
  return {
    format: "serp-sst-software-review/v1",
    observed_at: new Date().toISOString(),
    activation_allowed: false,
    states: results.sort((a, b) => a.region.localeCompare(b.region)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  collectSoftwareReview()
    .then((review) => process.stdout.write(JSON.stringify(review, null, 2) + "\n"))
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
}
