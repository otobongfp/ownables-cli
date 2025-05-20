const chalk = require("chalk");
const shell = require("shelljs");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const os = require("os");
const JSZip = require("jszip");
const toml = require("@iarna/toml");
const sharp = require("sharp");
const ora = require("ora");
const { EventChain, LTO, Event } = require("@ltonetwork/lto");
const { execAsync } = require("../utils/execAsync");
const {
  getOwnableType,
  handleStaticOwnable,
  handleMusicOwnable,
} = require("../utils/ownableTypes");


const REQUIRED_SCHEMA_FILES = [
  "instantiate_msg.json",
  "metadata.json",
  "info_response.json",
  "query_msg.json",
  "execute_msg.json",
];


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
  const buildDir = path.join(projectPath, "build");

  try {
    await fs.ensureDir(buildDir);

    const cargoToml = await fs.readFile(
      path.join(projectPath, "Cargo.toml"),
      "utf8"
    );
    const projectName = cargoToml.match(/name = "([^"]+)"/)[1];

    const wasmPath = path.join(buildDir, `${projectName}_bg.wasm`);
    const jsPath = path.join(buildDir, `${projectName}.js`);

    // Configure build environment
    process.env.RUSTFLAGS =
      "-C target-feature=+atomics,+bulk-memory,+mutable-globals";
    process.env.CARGO_TARGET_DIR = path.join(projectPath, "target");

    // Build WASM module
    spinner.text = "Building WebAssembly module...";
    try {
      const { stdout: wasmStdout, stderr: wasmStderr } = await execAsync(
        "cargo build --target wasm32-unknown-unknown --release",
        { cwd: projectPath }
      );
      if (wasmStderr) console.error(chalk.yellow(wasmStderr));
    } catch (error) {
      throw new Error(`WASM build failed: ${error.message}`);
    }

    // Gen. Js bindings directly to build directory
    spinner.text = "Generating JavaScript bindings...";
    try {
      const { stdout: bindgenStdout, stderr: bindgenStderr } = await execAsync(
        `wasm-bindgen target/wasm32-unknown-unknown/release/${projectName}.wasm --out-dir ${buildDir} --target web`,
        { cwd: projectPath }
      );
      if (bindgenStderr) console.error(chalk.yellow(bindgenStderr));
    } catch (error) {
      throw new Error(`WASM bindgen failed: ${error.message}`);
    }

    // Check if schema directory exists in build directory
    const schemaDir = path.join(buildDir, "schema");
    const schemaExists = await fs.pathExists(schemaDir);

    if (!schemaExists) {
      // Create schema directory in build
      await fs.ensureDir(schemaDir);

      // Gen schema files
      spinner.text = "Generating schema files...";
      try {
        const { stdout: schemaStdout, stderr: schemaStderr } = await execAsync(
          "cargo run --example schema",
          { cwd: projectPath }
        );
        if (schemaStderr) console.error(chalk.yellow(schemaStderr));

        // copy generated schema files to build directory
        const projectSchemaDir = path.join(projectPath, "schema");
        if (await fs.pathExists(projectSchemaDir)) {
          const schemaFiles = await fs.readdir(projectSchemaDir);
          await Promise.all(
            schemaFiles.map((file) =>
              fs.copy(
                path.join(projectSchemaDir, file),
                path.join(schemaDir, file)
              )
            )
          );
        }

        spinner.text = "Validating schema files...";
        const schemaFiles = await fs.readdir(schemaDir);

        const missingFiles = REQUIRED_SCHEMA_FILES.filter(
          (file) => !schemaFiles.includes(file)
        );

        if (missingFiles.length > 0) {
          throw new Error(
            `Missing required schema files: ${missingFiles.join(", ")}`
          );
        }

        // Validate each schema file is valid JSON
        await Promise.all(
          schemaFiles.map(async (file) => {
            try {
              const content = await fs.readFile(
                path.join(schemaDir, file),
                "utf8"
              );
              JSON.parse(content);
            } catch (error) {
              throw new Error(`Invalid schema file ${file}: ${error.message}`);
            }
          })
        );

        spinner.text = "Schema files validated successfully";
      } catch (error) {
        throw new Error(`Schema generation failed: ${error.message}`);
      }
    } else {
      spinner.text = "Using existing schema files...";
    }

    spinner.text = "Build process completed";
    return {
      wasmPath,
      jsPath,
    };
  } catch (error) {
    throw new Error(`Failed to build WebAssembly: ${error.message}`);
  }
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

async function getMetadataFromCargo() {
  const cwd = process.cwd();
  const cargoPath = path.join(cwd, "Cargo.toml");
  const cargoContent = await fs.readFile(cargoPath, "utf8");
  const cargoData = toml.parse(cargoContent);

  return {
    name: cargoData.package.name.replace(/"/g, ""),
    description: cargoData.package.description.replace(/"/g, ""),
    version: cargoData.package.version.replace(/"/g, ""),
    authors: cargoData.package.authors || [],
    keywords: cargoData.package.keywords || [],
  };
}

async function createPackage(
  projectPath,
  outputPath,
  wasmPath,
  jsPath,
  metadata,
  ownableType,
  eventChain,
  spinner
) {
  try {
    // Create output directories in parallel
    await Promise.all([
      fs.promises.mkdir(path.join(outputPath, "images"), { recursive: true }),
      fs.promises.mkdir(path.join(outputPath, "audio"), { recursive: true }),
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
      authors: metadata.authors ? [metadata.authors] : [],
      description: metadata.description,
      version: metadata.version,
      files: ["ownable_bg.wasm", "ownable.js", "ownable.d.ts"],
      module: "ownable.js",
      types: "ownable.d.ts",
      sideEffects: ["./snippets/*"],
      keywords: metadata.keywords ? metadata.keywords : [],
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
        metadata,
        spinner
      );
      // Update index.html with correct image references
      const indexHtml = await fs.promises.readFile(
        path.join(projectPath, "assets", "index.html"),
        "utf8"
      );
      const updatedHtml = indexHtml.replace(
        /PLACEHOLDER2_IMG/g,
        `images/${contentInfo.imageFile}`
      );
      await fs.promises.writeFile(
        path.join(outputPath, "index.html"),
        updatedHtml
      );
    } else if (ownableType === "music-ownable") {
      const contentInfo = await handleMusicOwnable(
        projectPath,
        outputPath,
        metadata,
        spinner
      );
      // Update index.html with correct image and audio references
      const indexHtml = await fs.promises.readFile(
        path.join(projectPath, "assets", "index.html"),
        "utf8"
      );
      const updatedHtml = indexHtml
        .replace(
          /src="PLACEHOLDER2_COVER"/g,
          `src="images/${contentInfo.coverArt}"`
        )
        .replace(
          /src="PLACEHOLDER2_BACKGROUND"/g,
          `src="images/${contentInfo.backdrop}"`
        )
        .replace(
          /src="PLACEHOLDER2_AUDIO"/g,
          `src="audio/${contentInfo.audioFile}"`
        );
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

    // Add WASM and JS files to ZIP with correct names
    const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");
    zip.file("ownable.wasm", await fs.promises.readFile(wasmPath));
    zip.file("ownable.js", await fs.promises.readFile(jsPath));
    zip.file("ownable_bg.wasm", await fs.promises.readFile(wasmPath));

    // Add rest of the files
    await addDirToZip(outputPath);

    const zipContent = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = path.join(process.cwd(), `${metadata.name}.zip`);
    await fs.promises.writeFile(zipPath, zipContent);

    return zipPath;
  } catch (error) {
    throw new Error(`Failed to create package: ${error.message}`);
  }
}

async function build() {
  const spinner = ora({
    text: "Starting build process...",
    color: "cyan",
    spinner: {
      frames: spinnerFrames,
      interval: 80,
    },
  }).start();

  const totalSteps = 6; // Total number of major steps
  let currentStep = 0;

  const updateProgress = (step, message) => {
    currentStep++;
    const percentage = Math.round((currentStep / totalSteps) * 100);
    spinner.text = `[${percentage}%] ${message}`;
  };

  try {
    updateProgress(1, "Checking environment...");
    await Promise.all([checkPrerequisites(), checkProjectStructure()]);

    updateProgress(2, "Building WebAssembly...");
    const { wasmPath, jsPath } = await buildWasm(process.cwd(), spinner);

    updateProgress(3, "Preparing package...");
    const metadata = await getMetadataFromCargo();

    //Get LTO seed
    spinner.stop();
    const { seed } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: "Enter an LTO seed phrase to sign an eventchain:",
        mask: "*",
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
    ]);
    spinner.start();

    updateProgress(4, "Setting up LTO...");
    const lto = new LTO("T");
    const account = lto.account({ seed: seed.trim() });
    const event = new Event();
    const eventChain = new EventChain(account);

    updateProgress(5, "Creating package...");
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ownable-")
    );
    const zipPath = await createPackage(
      process.cwd(),
      tmpDir,
      wasmPath,
      jsPath,
      metadata,
      await getOwnableType(process.cwd()),
      eventChain,
      spinner
    );

    // Cleanup
    updateProgress(6, "Cleaning up...");
    await fs.remove(tmpDir);

    spinner.succeed("Build completed successfully! 🎉");
    console.log(`\nPackage created at: ${zipPath}`);
  } catch (error) {
    spinner.fail("Build failed");
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

async function clean(projectPath) {
  const spinner = ora({
    text: "Cleaning build cache...",
    color: "cyan",
    spinner: {
      frames: spinnerFrames,
      interval: 80,
    },
    prefixText: chalk.cyan("🧹"),
    suffixText: chalk.cyan("🧹"),
  }).start();

  try {
    // Clean build
    const buildDir = path.join(projectPath, "build");
    if (await fs.pathExists(buildDir)) {
      spinner.text = "Removing build directory...";
      await fs.remove(buildDir);
    }

    // Clean target
    const targetDir = path.join(projectPath, "target");
    if (await fs.pathExists(targetDir)) {
      spinner.text = "Removing target directory...";
      await fs.remove(targetDir);
    }

    spinner.succeed(chalk.cyan("Build cache cleaned successfully!"));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to clean build cache: ${error.message}`));
    process.exit(1);
  }
}

module.exports = {
  build,
  clean,
};
