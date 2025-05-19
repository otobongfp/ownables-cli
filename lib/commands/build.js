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
const ora = require("ora");
const { EventChain, Account, LTO, Event } = require("@ltonetwork/lto");
const { execAsync } = require("../utils/execAsync");
const { execSync } = require("child_process");
const {
  getOwnableType,
  handleStaticOwnable,
  handleMusicOwnable,
} = require("../utils/ownableTypes");
const { handleSchema } = require("../utils/stores");
const execa = require("execa");

// Custom spinner frames
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getOSInfo() {
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const isLinux = platform === "linux";

  return {
    platform,
    isWindows,
    isMac,
    isLinux,
    name: isWindows
      ? "Windows"
      : isMac
      ? "macOS"
      : isLinux
      ? "Linux"
      : "Unknown",
  };
}

function getInstallInstructions(tool) {
  const osInfo = getOSInfo();

  const instructions = {
    rust: {
      windows: "Visit https://rustup.rs/ and download the installer",
      mac: "Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      linux:
        "Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    },
    docker: {
      windows:
        "Download Docker Desktop from https://www.docker.com/products/docker-desktop",
      mac: "Download Docker Desktop from https://www.docker.com/products/docker-desktop",
      linux: "Run: curl -fsSL https://get.docker.com | sh",
    },
  };

  return instructions[tool][
    osInfo.platform === "win32"
      ? "windows"
      : osInfo.platform === "darwin"
      ? "mac"
      : "linux"
  ];
}

async function checkPrerequisites() {
  const osInfo = getOSInfo();
  console.log(chalk.cyan(`\nDetected OS: ${osInfo.name}`));

  // Check if Rust is installed
  if (!shell.which("rustc")) {
    throw new Error(
      `Rust is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  // Check if cargo is installed
  if (!shell.which("cargo")) {
    throw new Error(
      `Cargo is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  // Check if wasm-bindgen is installed
  if (!shell.which("wasm-bindgen")) {
    throw new Error(
      "wasm-bindgen is not installed. Please install it with: cargo install wasm-bindgen-cli"
    );
  }

  // Check if rust-optimizer is available
  if (!shell.which("docker")) {
    throw new Error(
      `Docker is not installed. Please install Docker first:\n${getInstallInstructions(
        "docker"
      )}`
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

  // Additional OS-specific checks
  if (osInfo.isWindows) {
    // Check for Visual Studio Build Tools on Windows
    const vsWhere =
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
    if (!fs.existsSync(vsWhere)) {
      console.warn(
        chalk.yellow(
          "Visual Studio Build Tools not found. You may need to install them for full Rust support."
        )
      );
    }
  }

  if (osInfo.isMac) {
    // Check for Xcode Command Line Tools on macOS
    if (!shell.which("xcode-select")) {
      console.warn(
        chalk.yellow(
          "Xcode Command Line Tools not found. You may need to install them for full Rust support."
        )
      );
    }
  }

  if (osInfo.isLinux) {
    // Check for essential build tools on Linux
    const buildEssentials = shell.exec("dpkg -l | grep build-essential", {
      silent: true,
    });
    if (buildEssentials.code !== 0) {
      console.warn(
        chalk.yellow(
          "build-essential package not found. You may need to install it: sudo apt-get install build-essential"
        )
      );
    }
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
  console.log(chalk.cyan("\nStarting WebAssembly build process..."));

  // Read project name from Cargo.toml
  const cargoToml = await fs.readFile(
    path.join(projectPath, "Cargo.toml"),
    "utf8"
  );
  const projectName = cargoToml.match(/name = "([^"]+)"/)[1];
  console.log(chalk.cyan(`Project name: ${projectName}`));

  // Set build environment
  const env = {
    ...process.env,
    RUSTFLAGS: "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
    CARGO_TARGET_DIR: path.join(projectPath, "target"),
  };
  console.log(chalk.cyan(`Build environment configured`));
  console.log(chalk.gray(`Target directory: ${env.CARGO_TARGET_DIR}`));

  try {
    // Build WebAssembly module
    console.log(chalk.cyan("\nBuilding WebAssembly module..."));
    const { stdout: wasmStdout, stderr: wasmStderr } = await execa(
      "cargo",
      ["build", "--target", "wasm32-unknown-unknown", "--release"],
      {
        cwd: projectPath,
        env,
      }
    );
    console.log(chalk.gray(wasmStdout));
    if (wasmStderr) console.warn(chalk.yellow(wasmStderr));

    // Generate JavaScript bindings
    console.log(chalk.cyan("\nGenerating JavaScript bindings..."));
    const wasmPath = path.join(
      projectPath,
      "target",
      "wasm32-unknown-unknown",
      "release",
      `${projectName}.wasm`
    );
    console.log(chalk.gray(`WASM file path: ${wasmPath}`));

    const { stdout: bindgenStdout, stderr: bindgenStderr } = await execa(
      "wasm-bindgen",
      [
        wasmPath,
        "--out-dir",
        projectPath,
        "--target",
        "web",
        "--no-typescript",
      ],
      {
        cwd: projectPath,
      }
    );
    console.log(chalk.gray(bindgenStdout));
    if (bindgenStderr) console.warn(chalk.yellow(bindgenStderr));

    // Verify WASM files exist
    const wasmFiles = [
      path.join(projectPath, `${projectName}_bg.wasm`),
      path.join(projectPath, `${projectName}.js`),
    ];

    console.log(chalk.cyan("\nVerifying WASM files..."));
    for (const file of wasmFiles) {
      const exists = await fs.pathExists(file);
      console.log(
        chalk.gray(`${path.basename(file)}: ${exists ? "Found" : "Missing"}`)
      );
      if (!exists) {
        throw new Error(`Required file not found: ${file}`);
      }
    }

    // Generate schema files
    console.log(chalk.cyan("\nChecking schema status..."));
    const schemaDir = path.join(projectPath, "schema");
    const hasSchema = await fs.pathExists(schemaDir);
    console.log(chalk.gray(`Schema directory: ${schemaDir}`));
    console.log(chalk.gray(`Schema exists: ${hasSchema}`));

    if (!hasSchema) {
      console.log(chalk.cyan("Generating schema files..."));
      const { stdout: schemaStdout, stderr: schemaStderr } = await execa(
        "cargo",
        ["run", "--example", "schema"],
        {
          cwd: projectPath,
        }
      );
      console.log(chalk.gray(schemaStdout));
      if (schemaStderr) console.warn(chalk.yellow(schemaStderr));
    } else {
      console.log(chalk.green("Using existing schema files"));
    }

    console.log(chalk.green("\nWebAssembly build completed successfully"));
    return {
      wasmPath: path.join(projectPath, `${projectName}_bg.wasm`),
      jsPath: path.join(projectPath, `${projectName}.js`),
    };
  } catch (error) {
    console.error(chalk.red("\nError building WebAssembly:"));
    console.error(chalk.red(error.message));
    if (error.stderr) console.error(chalk.red(error.stderr));
    throw error;
  }
}

async function optimizeWasm(spinner) {
  spinner.text = chalk.cyan("Optimizing WebAssembly (0%)");
  // Run rust-optimizer using the script defined in Cargo.toml
  const optimizeResult = shell.exec("cargo run-script optimize", {
    silent: true,
  });

  if (optimizeResult.code !== 0) {
    throw new Error(`WASM optimization failed: ${optimizeResult.stderr}`);
  }
  spinner.text = chalk.cyan("WebAssembly optimization complete (100%)");
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

async function createPackage(
  projectPath,
  outputPath,
  wasmPath,
  jsPath,
  metadata,
  ownableType,
  eventChain
) {
  // Create output directories in parallel
  await Promise.all([
    fs.promises.mkdir(path.join(outputPath, "images"), { recursive: true }),
    fs.promises.mkdir(path.join(outputPath, "audio"), { recursive: true }),
  ]);

  // Copy WASM and JS files to root directory
  await Promise.all([
    fs.promises.copyFile(wasmPath, path.join(outputPath, "ownable.wasm")),
    fs.promises.copyFile(
      path.join(
        path.dirname(wasmPath),
        `${path.basename(wasmPath, ".wasm")}_bg.wasm`
      ),
      path.join(outputPath, "ownable_bg.wasm")
    ),
    fs.promises.copyFile(jsPath, path.join(outputPath, "ownable.js")),
  ]);

  // Copy schema files from the project's schema directory
  const schemaDir = path.join(projectPath, "schema");
  const schemaFiles = await fs.promises.readdir(schemaDir);
  await Promise.all(
    schemaFiles.map((file) =>
      fs.promises.copyFile(
        path.join(schemaDir, file),
        path.join(outputPath, file)
      )
    )
  );

  // Create package.json
  const packageJson = {
    name: metadata.name,
    version: "1.0.0",
    description: metadata.description,
    author: metadata.author,
    type: "module",
  };

  // Write package.json
  await fs.promises.writeFile(
    path.join(outputPath, "package.json"),
    JSON.stringify(packageJson, null, 2)
  );

  // Create metadata.json
  await fs.promises.writeFile(
    path.join(outputPath, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );

  // Create chain.json
  const chainJson = eventChain.toJSON();
  await fs.promises.writeFile(
    path.join(outputPath, "chain.json"),
    JSON.stringify(chainJson, null, 2)
  );

  // Handle assets based on ownable type
  if (ownableType === "static-ownable") {
    const contentInfo = await handleStaticOwnable(
      projectPath,
      outputPath,
      metadata
    );
    // Update index.html with correct image references
    const indexHtml = await fs.promises.readFile(
      path.join(projectPath, "assets", "index.html"),
      "utf8"
    );
    const updatedHtml = indexHtml
      .replace(/PLACEHOLDER1_IMAGE/g, `"images/${contentInfo.imageFile}"`)
      .replace(/PLACEHOLDER1_BACKGROUND/g, `"images/${contentInfo.imageFile}"`);
    await fs.promises.writeFile(
      path.join(outputPath, "index.html"),
      updatedHtml
    );
  } else if (ownableType === "music-ownable") {
    const contentInfo = await handleMusicOwnable(
      projectPath,
      outputPath,
      metadata
    );
    // Update index.html with correct image and audio references
    const indexHtml = await fs.promises.readFile(
      path.join(projectPath, "assets", "index.html"),
      "utf8"
    );
    const updatedHtml = indexHtml
      .replace(/PLACEHOLDER2_COVER/g, `"images/${contentInfo.coverArt}"`)
      .replace(/PLACEHOLDER2_BACKGROUND/g, `"images/${contentInfo.backdrop}"`)
      .replace(/PLACEHOLDER2_AUDIO/g, `"audio/${contentInfo.audioFile}"`);
    await fs.promises.writeFile(
      path.join(outputPath, "index.html"),
      updatedHtml
    );
  }

  // Create ZIP file
  const zip = new JSZip();
  const addDirToZip = async (dirPath, zipPath = "") => {
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      files.map(async (file) => {
        const fullPath = path.join(dirPath, file.name);
        const relativePath = path.join(zipPath, file.name);
        if (file.isDirectory()) {
          await addDirToZip(fullPath, relativePath);
        } else {
          const content = await fs.promises.readFile(fullPath);
          zip.file(relativePath, content);
        }
      })
    );
  };

  await addDirToZip(outputPath);
  const zipContent = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = path.join(process.cwd(), `${metadata.name}.zip`);
  await fs.promises.writeFile(zipPath, zipContent);

  return zipPath;
}

async function build() {
  const spinner = ora({
    text: "Starting build process...",
    color: "cyan",
    spinner: {
      frames: spinnerFrames,
      interval: 80,
    },
    prefixText: chalk.cyan("⚡"),
    suffixText: chalk.cyan("⚡"),
  }).start();

  try {
    // Check prerequisites and project structure
    spinner.text = chalk.cyan("Checking environment (0%)");
    await Promise.all([checkPrerequisites(), checkProjectStructure()]);
    spinner.succeed(chalk.cyan("Environment ready (100%)"));

    // Build and optimize WASM
    spinner.text = chalk.cyan("Building WebAssembly (0%)");
    const { wasmPath, jsPath } = await buildWasm(process.cwd());
    await optimizeWasm(spinner);
    spinner.succeed(chalk.cyan("WebAssembly ready (100%)"));

    // Get metadata and create LTO account
    spinner.text = chalk.cyan("Preparing package (0%)");
    const metadata = await getMetadataFromCargo();

    spinner.stop();
    const { seed } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: chalk.cyan("Enter your LTO seed phrase:"),
        mask: "*",
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
    ]);
    spinner.start(chalk.cyan("Creating package..."));

    const lto = new LTO("T");
    const account = lto.account({ seed: seed.trim() });
    const event = new Event();
    const eventChain = new EventChain(account);

    // Create temporary directory for build
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ownable-")
    );

    // Create final package
    const zipPath = await createPackage(
      process.cwd(),
      tmpDir,
      wasmPath,
      jsPath,
      metadata,
      await getOwnableType(process.cwd()),
      eventChain
    );

    // Clean up temporary directory
    await fs.remove(tmpDir);

    spinner.succeed(chalk.cyan("\nBuild completed successfully! 🎉"));
    console.log(chalk.green(`\nPackage created at: ${zipPath}`));
  } catch (error) {
    spinner.fail(chalk.red(`\nBuild failed: ${error.message}`));
    process.exit(1);
  }
}

module.exports = {
  build,
};
