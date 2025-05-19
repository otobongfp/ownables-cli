const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

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
  return path.join(os.homedir(), ".ownables", "schema");
}

/**
 * Check if schema files exist in store and are valid
 */
async function getStoredSchema() {
  const storeDir = getSchemaStoreDir();

  try {
    // Check if store directory exists
    if (!(await fs.pathExists(storeDir))) {
      return null;
    }

    // Check if all required schema files exist
    const files = await fs.readdir(storeDir);
    const hasAllFiles = REQUIRED_SCHEMA_FILES.every((file) =>
      files.includes(file)
    );

    if (!hasAllFiles) {
      return null;
    }

    // Return path to stored schema directory
    return storeDir;
  } catch (error) {
    console.warn("Error checking schema store:", error);
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

    // Copy all schema files to store
    const files = await fs.readdir(schemaDir);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          fs.copyFile(path.join(schemaDir, file), path.join(storeDir, file))
        )
    );

    return storeDir;
  } catch (error) {
    console.warn("Error storing schema:", error);
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

    // Copy all schema files from store
    const files = await fs.readdir(storeDir);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          fs.copyFile(path.join(storeDir, file), path.join(schemaDir, file))
        )
    );

    return true;
  } catch (error) {
    console.warn("Error copying stored schema:", error);
    return false;
  }
}

/**
 * Main function to handle schema management
 */
async function handleSchema(projectPath) {
  // First check if schema files exist in project
  const projectSchemaDir = path.join(projectPath, "schema");
  const hasProjectSchema = await fs.pathExists(projectSchemaDir);

  if (hasProjectSchema) {
    // If schema exists in project, store it for future use
    await storeSchema(projectSchemaDir);
    return true;
  }

  // If no schema in project, check store
  const storedSchemaDir = await getStoredSchema();

  if (storedSchemaDir) {
    // Copy stored schema to project
    return await copyStoredSchema(storedSchemaDir, projectPath);
  }

  // If no stored schema, return false to indicate schema generation is needed
  return false;
}

module.exports = {
  handleSchema,
  REQUIRED_SCHEMA_FILES,
};
