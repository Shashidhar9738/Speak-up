const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");

// Every mutation is a read-modify-write against a single JSON file. Without
// serialization the await between read and write lets concurrent requests read
// the same snapshot and the last writer wins, silently dropping every record
// written in between. This promise chain makes mutations run one at a time.
let mutationChain = Promise.resolve();

function withLock(operation) {
  const result = mutationChain.then(operation, operation);
  // Keep the chain alive even when an operation rejects.
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStore() {
  const directoryPath = path.dirname(config.dataFilePath);
  await fs.mkdir(directoryPath, { recursive: true });

  try {
    await fs.access(config.dataFilePath);
  } catch {
    await fs.writeFile(config.dataFilePath, JSON.stringify({ submissions: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const fileContent = await fs.readFile(config.dataFilePath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(fileContent || "{}");
  } catch (error) {
    throw new Error(`Submission store at ${config.dataFilePath} is not valid JSON`);
  }

  return {
    submissions: Array.isArray(parsed.submissions) ? parsed.submissions : []
  };
}

// Write to a sibling temp file then rename. Rename is atomic on the same
// filesystem, so a crash mid-write cannot leave a truncated store behind.
async function writeStore(store) {
  await ensureStore();
  const payload = JSON.stringify({ submissions: store.submissions || [] }, null, 2);
  const tempPath = `${config.dataFilePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;

  try {
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, config.dataFilePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function listSubmissions() {
  const store = await readStore();
  return store.submissions;
}

async function createSubmission(submission) {
  return withLock(async () => {
    const store = await readStore();
    store.submissions.unshift(submission);
    await writeStore(store);
    return submission;
  });
}

async function updateSubmission(submissionId, updater) {
  return withLock(async () => {
    const store = await readStore();
    const index = store.submissions.findIndex((item) => item.id === submissionId);

    if (index === -1) {
      return null;
    }

    const currentValue = store.submissions[index];
    const nextValue = updater(currentValue);
    store.submissions[index] = nextValue;
    await writeStore(store);
    return nextValue;
  });
}

async function getSubmissionById(submissionId) {
  const store = await readStore();
  return store.submissions.find((item) => item.id === submissionId) || null;
}

module.exports = {
  listSubmissions,
  createSubmission,
  updateSubmission,
  getSubmissionById
};
