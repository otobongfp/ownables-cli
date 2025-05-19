const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const chalk = require("chalk");

// Schema files that should be present
const REQUIRED_SCHEMA_FILES = [
  "instantiate_msg.json",
  "execute_msg.json",
  "query_msg.json",
  "external_event_msg.json",
  "info_response.json",
  "metadata.json",
  "config.json",
];

/**
 * Get the global schema store directory
 */
function getSchemaStoreDir() {
  const homeDir = os.homedir();
  const storeDir = path.join(homeDir, ".ownables", "schema");

  console.log(chalk.cyan("\nSchema Store Configuration:"));
  console.log(chalk.cyan(`Home Directory: ${homeDir}`));
  console.log(chalk.cyan(`Schema Store: ${storeDir}`));
  console.log(chalk.cyan(`Absolute Path: ${path.resolve(storeDir)}`));

  return storeDir;
}

/**
 * Calculate hash of schema files to determine if they've changed
 */
async function calculateSchemaHash(schemaDir) {
  const files = await fs.readdir(schemaDir);
  const hash = crypto.createHash("sha256");

  for (const file of files) {
    if (file.endsWith(".json")) {
      const content = await fs.readFile(path.join(schemaDir, file), "utf8");
      hash.update(content);
    }
  }

  return hash.digest("hex");
}

/**
 * Check if schema files exist in store and are valid
 */
async function getStoredSchema() {
  const storeDir = getSchemaStoreDir();

  try {
    // Check if store directory exists
    if (!(await fs.pathExists(storeDir))) {
      console.log(chalk.yellow("No schema store found"));
      return null;
    }

    // Check if all required schema files exist
    const files = await fs.readdir(storeDir);
    console.log(chalk.cyan(`Found ${files.length} schema files in store`));

    const hasAllFiles = REQUIRED_SCHEMA_FILES.every((file) =>
      files.includes(file)
    );

    if (!hasAllFiles) {
      console.log(chalk.yellow("Missing required schema files"));
      return null;
    }

    console.log(chalk.green("Found valid schema in store"));
    return storeDir;
  } catch (error) {
    console.warn(chalk.red("Error checking schema store:"), error);
    return null;
  }
}

/**
 * Store schema files for future use
 */
async function storeSchema(schemaDir) {
  const storeDir = getSchemaStoreDir();

  try {
    // Create store directory if it doesn't exist
    await fs.ensureDir(storeDir);
    console.log(chalk.cyan("Created schema store directory"));

    // Copy all schema files to store
    const files = await fs.readdir(schemaDir);
    console.log(chalk.cyan(`Copying ${files.length} schema files to store`));

    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          fs.copyFile(path.join(schemaDir, file), path.join(storeDir, file))
        )
    );

    console.log(chalk.green("Successfully stored schema files"));
    return storeDir;
  } catch (error) {
    console.warn(chalk.red("Error storing schema:"), error);
    return null;
  }
}

/**
 * Copy stored schema files to project directory
 */
async function copyStoredSchema(storeDir, projectDir) {
  const schemaDir = path.join(projectDir, "schema");

  try {
    // Create schema directory if it doesn't exist
    await fs.ensureDir(schemaDir);
    console.log(chalk.cyan("Created project schema directory"));

    // Copy all schema files from store
    const files = await fs.readdir(storeDir);
    console.log(chalk.cyan(`Copying ${files.length} schema files to project`));

    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          fs.copyFile(path.join(storeDir, file), path.join(schemaDir, file))
        )
    );

    console.log(chalk.green("Successfully copied schema files to project"));
    return true;
  } catch (error) {
    console.warn(chalk.red("Error copying stored schema:"), error);
    return false;
  }
}

/**
 * Main function to handle schema management
 */
async function handleSchema(projectPath) {
  console.log(chalk.cyan("\nChecking schema status..."));

  // First check if schema files exist in project
  const projectSchemaDir = path.join(projectPath, "schema");
  const hasProjectSchema = await fs.pathExists(projectSchemaDir);

  if (hasProjectSchema) {
    console.log(chalk.cyan("Found schema in project, storing for future use"));
    // If schema exists in project, store it for future use
    await storeSchema(projectSchemaDir);
    return true;
  }

  // If no schema in project, check store
  console.log(chalk.cyan("No schema in project, checking store..."));
  const storedSchemaDir = await getStoredSchema();

  if (storedSchemaDir) {
    // Copy stored schema to project
    return await copyStoredSchema(storedSchemaDir, projectPath);
  }

  console.log(
    chalk.yellow("No schema found in store, will generate new schema")
  );
  // If no stored schema, return false to indicate schema generation is needed
  return false;
}

module.exports = {
  handleSchema,
  REQUIRED_SCHEMA_FILES,
};
