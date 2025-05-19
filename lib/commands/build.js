const chalk = require("chalk");
const shell = require("shelljs");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const os = require("os");
const tmp = require("tmp");
const JSZip = require("jszip");
const toml = require("@iarna/toml");
const sharp = require("sharp");
const { EventChain, Account, LTO, Event } = require("@ltonetwork/lto");
const { execAsync } = require("../utils/execAsync");

async function checkPrerequisites() {
  // Check if Rust is installed
  if (!shell.which("rustc")) {
    throw new Error(
      "Rust is not installed. Please install Rust first: https://rustup.rs/"
    );
  }

  // Check if cargo is installed
  if (!shell.which("cargo")) {
    throw new Error(
      "Cargo is not installed. Please install Rust first: https://rustup.rs/"
    );
  }

  // Check if rust-optimizer is available
  if (!shell.which("docker")) {
    throw new Error(
      "Docker is not installed. Please install Docker first: https://docs.docker.com/get-docker/"
    );
  }

  // Check if wasm32 target is installed
  const wasmTargetResult = shell.exec("rustup target list --installed", {
    silent: true,
  });
  if (!wasmTargetResult.stdout.includes("wasm32-unknown-unknown")) {
    throw new Error(
      "WebAssembly target not installed. Please run: rustup target add wasm32-unknown-unknown"
    );
  }
}

async function checkProjectStructure() {
  const cwd = process.cwd();

  // Check if Cargo.toml exists
  if (!fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    throw new Error(
      "No Cargo.toml found in the current directory. Please run this command in an Ownable project directory."
    );
  }

  // Check if src directory exists
  if (!fs.existsSync(path.join(cwd, "src"))) {
    throw new Error(
      "No src directory found. Please ensure this is a valid Ownable project."
    );
  }

  // Check if assets directory exists
  if (!fs.existsSync(path.join(cwd, "assets"))) {
    throw new Error(
      "No assets directory found. Please ensure this is a valid Ownable project."
    );
  }

  // Check if index.html exists
  if (!fs.existsSync(path.join(cwd, "assets", "index.html"))) {
    throw new Error("No index.html found in assets directory.");
  }

  // Check if images directory exists
  if (!fs.existsSync(path.join(cwd, "assets", "images"))) {
    throw new Error("No images directory found in assets directory.");
  }

  // Check if there are any images in the images directory
  const imagesDir = path.join(cwd, "assets", "images");
  const images = await fs.readdir(imagesDir);
  if (images.length === 0) {
    throw new Error("No images found in assets/images directory.");
  }
}

async function buildWasm(projectPath) {
  console.log("Building WASM...");

  // Clean up cargo cache to free space
  console.log("Cleaning up cargo cache...");
  try {
    await execAsync("cargo clean", { cwd: projectPath });
  } catch (error) {
    console.warn("Cleanup warning:", error);
  }

  // Read project name from Cargo.toml
  const cargoToml = fs.readFileSync(
    path.join(projectPath, "Cargo.toml"),
    "utf8"
  );
  const projectName = cargoToml.match(/name = "([^"]+)"/)[1];

  // Clean previous builds
  console.log("Cleaning previous builds...");
  const targetDir = path.join(projectPath, "target");
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  // Build with cargo
  console.log("Building with cargo...");
  try {
    const { stdout, stderr } = await execAsync(
      "cargo build --target wasm32-unknown-unknown --release",
      {
        cwd: projectPath,
        env: {
          ...process.env,
          RUSTFLAGS: "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
          CARGO_HTTP_MULTIPLEXING: "false",
        },
      }
    );

    if (stderr) {
      console.error("Build stderr:", stderr);
    }
    if (stdout) {
      console.log("Build stdout:", stdout);
    }

    // Create output directory
    const outputDir = path.join(targetDir, "wasm32-unknown-unknown", "release");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Copy the built files
    const wasmFile = path.join(
      targetDir,
      "wasm32-unknown-unknown",
      "release",
      `${projectName}.wasm`
    );
    const jsFile = path.join(
      targetDir,
      "wasm32-unknown-unknown",
      "release",
      `${projectName}.js`
    );

    console.log("Build completed successfully");
    return {
      wasmPath: wasmFile,
      jsPath: jsFile,
    };
  } catch (error) {
    console.error("Build failed:", error);
    throw error;
  }
}

async function optimizeWasm() {
  console.log(chalk.blue("Optimizing WASM..."));

  // Run rust-optimizer using the script defined in Cargo.toml
  const optimizeResult = shell.exec("cargo run-script optimize", {
    silent: true,
  });

  if (optimizeResult.code !== 0) {
    throw new Error(`WASM optimization failed: ${optimizeResult.stderr}`);
  }

  console.log(chalk.green("WASM optimization successful!"));
}

async function resizeToThumbnail(input) {
  try {
    const resized = await sharp(input)
      .resize(50, 50)
      .webp({ quality: 80 })
      .toBuffer();

    if (resized.length > 256 * 1024) {
      throw new Error("Thumbnail exceeds 256KB");
    }

    return resized;
  } catch (error) {
    throw new Error(`Failed to create thumbnail: ${error.message}`);
  }
}

async function copyAssetsToOutput(ownablePath, outputPath) {
  const assetsPath = path.join(ownablePath, "assets");
  const assets = await fs.readdir(assetsPath);
  for (const asset of assets) {
    const assetPath = path.join(assetsPath, asset);
    const outputAssetPath = path.join(outputPath, asset);
    await fs.copyFile(assetPath, outputAssetPath);
  }
}

async function copyExampleOutputToOutput(outputPath) {
  const exampleOutputPath = path.join(__dirname, "../../../example_output");
  const exampleOutputFiles = await fs.readdir(exampleOutputPath);
  for (const file of exampleOutputFiles) {
    // Skip metadata.json and package.json as they are already handled
    if (file === "metadata.json" || file === "package.json") {
      continue;
    }
    const filePath = path.join(exampleOutputPath, file);
    const outputFilePath = path.join(outputPath, file);
    await fs.copyFile(filePath, outputFilePath);
  }
}

async function getMetadataFromCargo() {
  const cwd = process.cwd();
  const cargoPath = path.join(cwd, "Cargo.toml");
  const cargoContent = await fs.readFile(cargoPath, "utf8");
  const cargoData = toml.parse(cargoContent);

  return {
    name: cargoData.package.name.replace(/"/g, ""),
    description: cargoData.package.description.replace(/"/g, ""),
    version: cargoData.package.version.replace(/"/g, ""),
    authors: cargoData.package.authors[0].replace(/"/g, ""),
    keywords: cargoData.package.keywords
      .map((k) => k.replace(/"/g, ""))
      .join(", "),
  };
}

async function createPackage(projectPath, outputPath, metadata, account) {
  const zip = new JSZip();
  const outputDir = path.join(os.tmpdir(), "ownable-build");
  await fs.ensureDir(outputDir);

  // Get project name from metadata
  const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");

  // Copy WASM and JS files from target directory
  await fs.copy(
    path.join(
      projectPath,
      "target/wasm32-unknown-unknown/release",
      `${projectName}.wasm`
    ),
    path.join(outputDir, "ownable_bg.wasm")
  );
  // Only copy JS if it exists (for compatibility)
  const jsSource = path.join(
    projectPath,
    "target/wasm32-unknown-unknown/release",
    `${projectName}.js`
  );
  if (fs.existsSync(jsSource)) {
    await fs.copy(jsSource, path.join(outputDir, "ownable.js"));
  }

  // Create thumbnail
  const imagePath = path.join(
    projectPath,
    "assets/images",
    `${projectName}.jpg`
  );
  const thumbnailPath = path.join(outputDir, "thumbnail.webp");
  await sharp(imagePath)
    .resize(300, 300, { fit: "inside" })
    .webp({ quality: 80 })
    .toFile(thumbnailPath);

  // Generate schema files
  console.log("Generating schema files...");
  const schemaDir = path.join(projectPath, "schema");
  if (!fs.existsSync(schemaDir)) {
    fs.mkdirSync(schemaDir, { recursive: true });
  }

  // Run schema generation
  try {
    const { stdout, stderr } = await execAsync("cargo run --example schema", {
      cwd: projectPath,
    });

    if (stderr) {
      console.error("Schema generation stderr:", stderr);
    }
    if (stdout) {
      console.log("Schema generation stdout:", stdout);
    }
  } catch (error) {
    console.error("Schema generation failed:", error);
    throw error;
  }

  // Copy schema files to output directory
  const schemaFiles = [
    "execute_msg.json",
    "instantiate_msg.json",
    "query_msg.json",
    "external_event_msg.json",
    "info_response.json",
    "metadata.json",
    "config.json",
  ];

  for (const file of schemaFiles) {
    const schemaPath = path.join(schemaDir, file);
    if (fs.existsSync(schemaPath)) {
      await fs.copy(schemaPath, path.join(outputDir, file));
    } else {
      console.warn(`Schema file ${file} not found`);
    }
  }

  // Create package.json
  const packageJson = {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    main: "ownable.js",
    types: "ownable.d.ts",
    files: [
      "ownable_bg.wasm",
      "ownable.js",
      "ownable.d.ts",
      "thumbnail.webp",
      "chain.json",
      "metadata.json",
      "instantiate_msg.json",
      "execute_msg.json",
      "query_msg.json",
      "info_response.json",
      "external_event_msg.json",
      "config.json",
      "index.html",
    ],
  };
  await fs.writeJson(path.join(outputDir, "package.json"), packageJson, {
    spaces: 2,
  });

  // Create package-lock.json
  const packageLockJson = {
    name: metadata.name,
    version: metadata.version,
    lockfileVersion: 1,
    requires: true,
    packages: {
      "": {
        name: metadata.name,
        version: metadata.version,
      },
    },
  };
  await fs.writeJson(
    path.join(outputDir, "package-lock.json"),
    packageLockJson,
    {
      spaces: 2,
    }
  );

  // Create metadata.json
  const metadataJson = {
    name: metadata.name,
    description: metadata.description,
    image: "thumbnail.webp",
    image_data: null,
    external_url: null,
    background_color: null,
    animation_url: null,
    youtube_url: null,
  };
  await fs.writeJson(path.join(outputDir, "metadata.json"), metadataJson, {
    spaces: 2,
  });

  // Create index.html
  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <title>${metadata.name}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <img src="thumbnail.webp" alt="${metadata.name}">
</body>
</html>`;
  await fs.writeFile(path.join(outputDir, "index.html"), indexHtml);

  // Create chain.json using LTO library
  console.log("[DEBUG] Creating EventChain...");
  const chain = new EventChain(account);
  console.log("[DEBUG] EventChain created:", chain);

  // Add instantiate event
  try {
    console.log("[DEBUG] Adding instantiate event to chain...");
    const msg = {
      "@context": "instantiate_msg.json",
      ownable_id: chain.id,
      package: "random cid for now",
      network_id: "T",
      keywords: metadata.keywords.split(", "),
      ownable_type: "image",
    };
    const instantiateEvent = new Event(msg).addTo(chain).signWith(account);
    console.log("[DEBUG] Instantiate event added:", instantiateEvent);
  } catch (e) {
    console.log("[DEBUG] Error adding instantiate event:", e);
    throw e;
  }

  try {
    console.log("[DEBUG] Writing chain.json...");
    const chainJson = chain.toJSON();
    const uniqueMessageHash = chain.latestHash.hex;
    const outputChainJson = {
      ...chainJson,
      uniqueMessageHash,
      keywords: metadata.keywords.split(", "),
    };
    await fs.writeJson(path.join(outputDir, "chain.json"), outputChainJson, {
      spaces: 2,
    });
    console.log("[DEBUG] chain.json written.");
  } catch (e) {
    console.log("[DEBUG] Error writing chain.json:", e);
    throw e;
  }

  // Add all files to ZIP
  const files = await fs.readdir(outputDir);
  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const stats = await fs.stat(filePath);

    if (stats.isFile()) {
      const content = await fs.readFile(filePath);
      zip.file(file, content);
    }
  }

  // Generate ZIP file
  const zipContent = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(outputPath, zipContent);

  // Cleanup
  await fs.remove(outputDir);
}

async function build() {
  try {
    console.log(chalk.blue("Starting Ownable build process..."));

    // Check prerequisites
    await checkPrerequisites();
    console.log(chalk.green("✓ Prerequisites met"));

    // Check project structure
    await checkProjectStructure();
    console.log(chalk.green("✓ Project structure valid"));

    // Build WASM
    const { wasmPath, jsPath } = await buildWasm(process.cwd());

    // Optimize WASM
    await optimizeWasm();

    // Get metadata from Cargo.toml
    const metadata = await getMetadataFromCargo();
    console.log(chalk.green("✓ Metadata loaded from Cargo.toml"));

    // Prompt user for seed phrase
    const { seed } = await inquirer.prompt([
      {
        type: "input",
        name: "seed",
        message: "Enter your LTO seed phrase:",
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
    ]);

    // Create LTO account from seed
    const lto = new LTO("T"); // Use testnet
    const account = lto.account({ seed: seed.trim() });
    console.log(chalk.green("✓ LTO account created from seed"));

    // Create package
    await createPackage(
      process.cwd(),
      path.join(process.cwd(), `${metadata.name}.zip`),
      metadata,
      account
    );

    console.log(chalk.green("\nBuild completed successfully! 🎉"));
  } catch (error) {
    console.error(chalk.red(`\nBuild failed: ${error.message}`));
    process.exit(1);
  }
}

module.exports = {
  build,
};
