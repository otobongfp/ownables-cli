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
    sccache: {
      windows: "Run: cargo install sccache",
      mac: "Run: cargo install sccache",
      linux: "Run: cargo install sccache",
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

  // Check if sccache is installed
  if (!shell.which("sccache")) {
    console.warn(
      chalk.yellow(
        `sccache not found. Install it for faster builds:\n${getInstallInstructions(
          "sccache"
        )}`
      )
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

async function buildWasm(projectPath, spinner) {
  // Read project name from Cargo.toml
  const cargoToml = fs.readFileSync(
    path.join(projectPath, "Cargo.toml"),
    "utf8"
  );
  const projectName = cargoToml.match(/name = "([^"]+)"/)[1];

  // Configure build environment with optimized settings
  const env = {
    ...process.env,
    RUSTFLAGS:
      "-C target-feature=+atomics,+bulk-memory,+mutable-globals -C opt-level=3 -C debuginfo=0 -C codegen-units=16",
    CARGO_HTTP_MULTIPLEXING: "false",
    CC: "clang",
    CXX: "clang++",
    CARGO_BUILD_JOBS: os.cpus().length.toString(), // Use all available CPU cores
  };

  // Configure sccache for maximum performance
  const hasSccache = shell.which("sccache");
  if (hasSccache) {
    env.RUSTC_WRAPPER = "sccache";
    env.SCCACHE_DIR = path.join(os.homedir(), ".cache", "sccache");
    env.SCCACHE_CACHE_SIZE = "2G"; // Increase cache size
    env.SCCACHE_GHA_ENABLED = "true"; // Enable GitHub Actions cache if available
    spinner.text = chalk.cyan("Using sccache for faster builds");
  }

  try {
    spinner.text = chalk.cyan("Building WebAssembly (0%)");

    // Run cargo build with optimized settings
    const buildResult = await execAsync(
      `cargo build --target wasm32-unknown-unknown --release --jobs ${
        os.cpus().length
      }`,
      {
        cwd: projectPath,
        env,
      }
    );

    if (buildResult.stderr) {
      console.error("Build stderr:", buildResult.stderr);
    }

    // Parse cargo output for progress
    if (buildResult.stdout) {
      const lines = buildResult.stdout.split("\n");
      let progress = 0;
      for (const line of lines) {
        if (line.includes("Compiling")) {
          progress += 10;
          spinner.text = chalk.cyan(
            `Building WebAssembly (${progress}%) - ${line.trim()}`
          );
        }
      }
    }

    spinner.text = chalk.cyan("Generating JavaScript bindings (50%)");

    // Prepare paths
    const wasmPath = path.join(
      projectPath,
      "target/wasm32-unknown-unknown/release",
      `${projectName}.wasm`
    );
    const outDir = path.join(
      projectPath,
      "target/wasm32-unknown-unknown/release"
    );

    // Run wasm-bindgen with optimized settings
    const { stdout: bindgenStdout, stderr: bindgenStderr } = await execAsync(
      `wasm-bindgen ${wasmPath} --out-dir ${outDir} --target web --no-typescript --no-demangle`,
      {
        cwd: projectPath,
      }
    );

    if (bindgenStderr) {
      console.error("wasm-bindgen stderr:", bindgenStderr);
    }
    if (bindgenStdout) {
      console.log("wasm-bindgen stdout:", bindgenStdout);
    }

    spinner.text = chalk.cyan("WebAssembly build complete (100%)");
    return {
      wasmPath: path.join(outDir, `${projectName}_bg.wasm`),
      jsPath: path.join(outDir, `${projectName}.js`),
    };
  } catch (error) {
    console.error("Build failed:", error);
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

async function createPackage(projectPath, outputDir, metadata, spinner) {
  const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");

  // Get ownable type
  const ownableType = await getOwnableType(projectPath);

  // Create media directories based on ownable type
  if (ownableType === "static-ownable") {
    await fs.ensureDir(path.join(outputDir, "images"));
  } else if (ownableType === "music-ownable") {
    await Promise.all([
      fs.ensureDir(path.join(outputDir, "images")),
      fs.ensureDir(path.join(outputDir, "audio")),
    ]);
  }

  // Handle content based on ownable type
  let contentInfo;
  if (ownableType === "static-ownable") {
    contentInfo = await handleStaticOwnable(
      projectPath,
      outputDir,
      metadata,
      spinner
    );
  } else if (ownableType === "music-ownable") {
    contentInfo = await handleMusicOwnable(
      projectPath,
      outputDir,
      metadata,
      spinner
    );
  } else {
    throw new Error(`Unknown ownable type: ${ownableType}`);
  }

  // Copy WASM files to root
  spinner.text = "Copying WASM files...";
  await Promise.all([
    fs.copy(
      path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release",
        `${projectName}.wasm`
      ),
      path.join(outputDir, `${projectName}.wasm`)
    ),
    fs.copy(
      path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release",
        `${projectName}_bg.wasm`
      ),
      path.join(outputDir, `${projectName}_bg.wasm`)
    ),
    fs.copy(
      path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release",
        `${projectName}.js`
      ),
      path.join(outputDir, `${projectName}.js`)
    ),
  ]);

  // Process index.html
  spinner.text = "Processing index.html...";
  const indexPath = path.join(projectPath, "assets/index.html");
  let htmlContent = await fs.readFile(indexPath, "utf8");

  // Update image references based on ownable type
  if (ownableType === "static-ownable") {
    htmlContent = htmlContent.replace(
      /src=["']?([^"']+)["']?/g,
      (match, src) => {
        if (src === contentInfo.imageFile) {
          return `src="images/${contentInfo.imageFile}"`;
        }
        return match;
      }
    );
  } else if (ownableType === "music-ownable") {
    // Update audio source
    htmlContent = htmlContent.replace(
      /src=["']?([^"']+\.mp3)["']?/g,
      (match, src) => `src="audio/${contentInfo.audioFile}"`
    );

    // Update image sources
    htmlContent = htmlContent.replace(
      /src=["']?([^"']+)["']?/g,
      (match, src) => {
        if (src === contentInfo.coverArt) {
          return `src="images/${contentInfo.coverArt}"`;
        }
        if (src === contentInfo.background) {
          return `src="images/${contentInfo.background}"`;
        }
        return match;
      }
    );
  }

  // Write processed index.html
  await fs.writeFile(path.join(outputDir, "index.html"), htmlContent);

  // Copy schema files and create necessary JSON files
  spinner.text = "Copying schema files and creating JSON files...";
  await Promise.all([
    // Copy schema files if they exist
    (async () => {
      const schemaDir = path.join(projectPath, "schema");
      if (fs.existsSync(schemaDir)) {
        const schemaFiles = await fs.readdir(schemaDir);
        await Promise.all(
          schemaFiles.map(async (file) => {
            const sourcePath = path.join(schemaDir, file);
            const targetPath = path.join(outputDir, file);
            await fs.copy(sourcePath, targetPath);
          })
        );
      }
    })(),
    // Create package.json
    (async () => {
      const packageJson = {
        name: projectName,
        version: metadata.version,
        description: metadata.description,
        type: ownableType,
        files: [
          "index.html",
          "*.wasm",
          "*.js",
          "*.json",
          "thumbnail.webp",
          ownableType === "static-ownable" ? "images/" : "images/",
          ownableType === "music-ownable" ? "audio/" : undefined,
        ].filter(Boolean),
      };
      await fs.writeFile(
        path.join(outputDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      );
    })(),
    // Create ownable.js
    (async () => {
      const ownableJs = `// Ownable configuration
const config = {
  type: "${ownableType}",
  name: "${metadata.name}",
  description: "${metadata.description}",
  version: "${metadata.version}",
  author: "${metadata.authors}",
  keywords: "${metadata.keywords}",
};

export default config;`;
      await fs.writeFile(path.join(outputDir, "ownable.js"), ownableJs);
    })(),
    // Create metadata.json
    (async () => {
      const metadataJson = {
        name: metadata.name,
        description: metadata.description,
        version: metadata.version,
        author: metadata.authors,
        keywords: metadata.keywords.split(", "),
        type: ownableType,
      };
      await fs.writeFile(
        path.join(outputDir, "metadata.json"),
        JSON.stringify(metadataJson, null, 2)
      );
    })(),
  ]);

  // Create ZIP file
  spinner.text = "Creating ZIP file...";
  const zip = new JSZip();

  // Function to add a file to the ZIP
  const addFileToZip = async (filePath, zipPath) => {
    const content = await fs.readFile(filePath);
    zip.file(zipPath, content);
  };

  // Function to add a directory to the ZIP
  const addDirToZip = async (dirPath, zipPath) => {
    const files = await fs.readdir(dirPath);
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        const relativePath = path.join(zipPath, file);

        if (stats.isDirectory()) {
          await addDirToZip(filePath, relativePath);
        } else {
          await addFileToZip(filePath, relativePath);
        }
      })
    );
  };

  // Add all files and directories to the ZIP
  const files = await fs.readdir(outputDir);
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        await addDirToZip(filePath, file);
      } else {
        await addFileToZip(filePath, file);
      }
    })
  );

  // Generate the ZIP file
  const zipContent = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9,
    },
  });

  // Write the ZIP file
  const zipPath = path.join(process.cwd(), `${projectName}.zip`);
  await fs.writeFile(zipPath, zipContent);

  return {
    outputDir,
    zipPath,
  };
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
    const { wasmPath, jsPath } = await buildWasm(process.cwd(), spinner);
    await optimizeWasm(spinner);
    spinner.succeed(chalk.cyan("WebAssembly ready (100%)"));

    // Get metadata and create LTO account
    spinner.text = chalk.cyan("Preparing package (0%)");
    const metadata = await getMetadataFromCargo();

    spinner.stop();
    const { seed } = await inquirer.prompt([
      {
        type: "input",
        name: "seed",
        message: chalk.cyan("Enter your LTO seed phrase:"),
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
    ]);
    spinner.start(chalk.cyan("Creating package..."));

    const lto = new LTO("T");
    const account = lto.account({ seed: seed.trim() });

    // Create final package
    await createPackage(
      process.cwd(),
      path.join(process.cwd(), `${metadata.name}.zip`),
      metadata,
      spinner
    );

    spinner.succeed(chalk.cyan("\nBuild completed successfully! 🎉"));
  } catch (error) {
    spinner.fail(chalk.red(`\nBuild failed: ${error.message}`));
    process.exit(1);
  }
}

module.exports = {
  build,
};
