import path from "node:path";
import { getStagedNameStatus, getStagedShortStat } from "./git.js";

function parseNameStatus(nameStatusText) {
  const lines = nameStatusText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const parts = line.split(/\s+/);
    const status = parts[0];
    const file = parts[parts.length - 1];
    return { status, file };
  });
}

function buildHeuristicSummary(entries) {
  if (!entries.length) {
    return "update project files";
  }

  const statusBuckets = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };

  const areas = new Map();

  for (const entry of entries) {
    if (entry.status.startsWith("A")) statusBuckets.added += 1;
    else if (entry.status.startsWith("D")) statusBuckets.deleted += 1;
    else if (entry.status.startsWith("R")) statusBuckets.renamed += 1;
    else statusBuckets.modified += 1;

    const topArea = entry.file.split(/[\\/]/)[0] || path.basename(entry.file);
    areas.set(topArea, (areas.get(topArea) ?? 0) + 1);
  }

  const areaNames = [...areas.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  const areaText =
    areaNames.length > 0 ? `${areaNames.join(" and ")} modules` : "project modules";

  if (statusBuckets.added > 0 && statusBuckets.modified > 0) {
    return `implement updates in ${areaText} (${entries.length} files touched)`;
  }
  if (statusBuckets.added > 0) {
    return `add new changes in ${areaText} (${entries.length} files touched)`;
  }
  if (statusBuckets.deleted > 0 && statusBuckets.modified === 0) {
    return `remove obsolete files in ${areaText}`;
  }
  return `refine ${areaText} (${entries.length} files touched)`;
}

async function buildOpenAiSummary({ branch, nameStatusText, shortStat }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.AUTO_COMMIT_OPENAI_MODEL || "gpt-4o-mini";

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You write concise git commit summary fragments. Keep output under 16 words, no trailing period.",
      },
      {
        role: "user",
        content: `Branch: ${branch}\nDiff shortstat: ${shortStat || "n/a"}\nFiles:\n${nameStatusText}`,
      },
    ],
  };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const text =
      data.output_text ||
      data.output
        ?.flatMap((item) => item.content ?? [])
        ?.map((c) => c.text)
        ?.filter(Boolean)
        ?.join(" ")
        ?.trim();

    return text || null;
  } catch {
    return null;
  }
}

export async function generateSummary(repoPath, branch) {
  const [nameStatusText, shortStat] = await Promise.all([
    getStagedNameStatus(repoPath),
    getStagedShortStat(repoPath),
  ]);
  const entries = parseNameStatus(nameStatusText);

  if (!entries.length) {
    return "update tracked files";
  }

  const aiSummary = await buildOpenAiSummary({
    branch,
    nameStatusText,
    shortStat,
  });
  if (aiSummary) {
    return aiSummary.replace(/\s+/g, " ").trim();
  }

  return buildHeuristicSummary(entries);
}
