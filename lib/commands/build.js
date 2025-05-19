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

  // Configure build environment
  const env = {
    ...process.env,
    RUSTFLAGS: "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
    CARGO_HTTP_MULTIPLEXING: "false",
    CC: "clang",
    CXX: "clang++",
  };

  // Check for sccache and configure if available
  const hasSccache = shell.which("sccache");
  if (hasSccache) {
    env.RUSTC_WRAPPER = "sccache";
    env.SCCACHE_DIR = path.join(os.homedir(), ".cache", "sccache");
    spinner.text = chalk.cyan("Using sccache for faster builds");
  }

  try {
    // Run cargo build and wasm-bindgen in parallel
    spinner.text = chalk.cyan("Building WebAssembly (0%)");

    const [buildResult, bindgenResult] = await Promise.all([
      // Cargo build
      execAsync("cargo build --target wasm32-unknown-unknown --release", {
        cwd: projectPath,
        env,
      }),
      // Prepare wasm-bindgen command (will be executed after build)
      (async () => {
        const wasmPath = path.join(
          projectPath,
          "target/wasm32-unknown-unknown/release",
          `${projectName}.wasm`
        );
        return { wasmPath };
      })(),
    ]);

    if (buildResult.stderr) {
      console.error("Build stderr:", buildResult.stderr);
    }
    if (buildResult.stdout) {
      // Parse cargo output for progress
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

    // Run wasm-bindgen after build is complete
    const { stdout: bindgenStdout, stderr: bindgenStderr } = await execAsync(
      `wasm-bindgen ${bindgenResult.wasmPath} --out-dir ${path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release"
      )} --target web`,
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
      wasmPath: path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release",
        `${projectName}_bg.wasm`
      ),
      jsPath: path.join(
        projectPath,
        "target/wasm32-unknown-unknown/release",
        `${projectName}.js`
      ),
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

async function createPackage(
  projectPath,
  outputPath,
  metadata,
  account,
  spinner
) {
  const zip = new JSZip();
  const outputDir = path.join(os.tmpdir(), "ownable-build");
  await fs.ensureDir(outputDir);
  await fs.ensureDir(path.join(outputDir, "images")); // Create images directory

  // Get project name from metadata
  const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");

  // Find the image file in assets/images
  const imagesDir = path.join(projectPath, "assets/images");
  const images = await fs.readdir(imagesDir);
  const imageFile = images.find((file) => file.startsWith(projectName));
  if (!imageFile) {
    throw new Error(
      `No image file found for project ${projectName} in assets/images`
    );
  }

  // Process all files in parallel with progress tracking
  spinner.text = chalk.cyan("Processing files (0%)");
  let completedSteps = 0;
  const totalSteps = 5; // Total number of major processing steps

  await Promise.all([
    // Copy and process WASM/JS files
    (async () => {
      await Promise.all([
        fs.copy(
          path.join(
            projectPath,
            "target/wasm32-unknown-unknown/release",
            `${projectName}_bg.wasm`
          ),
          path.join(outputDir, "ownable_bg.wasm")
        ),
        fs.copy(
          path.join(
            projectPath,
            "target/wasm32-unknown-unknown/release",
            `${projectName}.js`
          ),
          path.join(outputDir, "ownable.js")
        ),
      ]);
      completedSteps++;
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - WASM/JS files copied`
      );
    })(),

    // Process images
    (async () => {
      const imagePath = path.join(projectPath, "assets/images", imageFile);
      await Promise.all([
        // Copy to images directory
        fs.copy(imagePath, path.join(outputDir, "images", imageFile)),
        // Create thumbnail
        sharp(imagePath)
          .resize(300, 300, { fit: "inside" })
          .webp({ quality: 80 })
          .toFile(path.join(outputDir, "thumbnail.webp")),
      ]);
      completedSteps++;
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Images processed`
      );
    })(),

    // Process index.html
    (async () => {
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Processing HTML`
      );
      const sourceIndexHtml = path.join(projectPath, "assets", "index.html");
      if (!fs.existsSync(sourceIndexHtml)) {
        throw new Error("No index.html found in assets directory");
      }
      let indexHtmlContent = await fs.readFile(sourceIndexHtml, "utf8");

      // Handle all possible image source patterns
      indexHtmlContent = indexHtmlContent
        .replace(/src=([^"'\s>]+)/g, 'src="$1"')
        .replace(/src=["'](?:images\/)?([^"']+)["']/g, (match, imageName) => {
          if (imageName === imageFile) {
            return `src="images/${imageName}"`;
          }
          return `src="${imageName}"`;
        })
        .replace(/src="([^"]+)\/"/g, 'src="$1"')
        .replace(/src=([^"']+)(?!["'])/g, 'src="$1"')
        .replace(/src=([^"'\s>]+)/g, 'src="$1"');

      await fs.writeFile(path.join(outputDir, "index.html"), indexHtmlContent);
      completedSteps++;
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - HTML processed`
      );
    })(),

    // Generate and copy schema files
    (async () => {
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Generating schemas`
      );
      const schemaDir = path.join(projectPath, "schema");
      if (!fs.existsSync(schemaDir)) {
        fs.mkdirSync(schemaDir, { recursive: true });
      }

      await execAsync("cargo run --example schema", {
        cwd: projectPath,
        env: {
          ...process.env,
          RUSTFLAGS: "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
          CARGO_HTTP_MULTIPLEXING: "false",
          CC: "clang",
          CXX: "clang++",
        },
      });

      const schemaFiles = [
        "execute_msg.json",
        "instantiate_msg.json",
        "query_msg.json",
        "external_event_msg.json",
        "info_response.json",
        "metadata.json",
        "config.json",
      ];

      await Promise.all(
        schemaFiles.map(async (file) => {
          const schemaPath = path.join(schemaDir, file);
          if (fs.existsSync(schemaPath)) {
            await fs.copy(schemaPath, path.join(outputDir, file));
          }
        })
      );
      completedSteps++;
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Schemas generated`
      );
    })(),

    // Create package files
    (async () => {
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Creating package files`
      );
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
          imageFile,
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

      await Promise.all([
        fs.writeJson(path.join(outputDir, "package.json"), packageJson, {
          spaces: 2,
        }),
        fs.writeJson(
          path.join(outputDir, "metadata.json"),
          {
            name: metadata.name,
            description: metadata.description,
            image: "thumbnail.webp",
            image_data: null,
            external_url: null,
            background_color: null,
            animation_url: null,
            youtube_url: null,
          },
          { spaces: 2 }
        ),
      ]);

      // Create chain.json
      const chain = new EventChain(account);
      const msg = {
        "@context": "instantiate_msg.json",
        ownable_id: chain.id,
        package: "random cid for now",
        network_id: "T",
        keywords: metadata.keywords.split(", "),
        ownable_type: "image",
      };
      new Event(msg).addTo(chain).signWith(account);
      const chainJson = chain.toJSON();
      const uniqueMessageHash = chain.latestHash.hex;
      await fs.writeJson(
        path.join(outputDir, "chain.json"),
        {
          ...chainJson,
          uniqueMessageHash,
          keywords: metadata.keywords.split(", "),
        },
        { spaces: 2 }
      );
      completedSteps++;
      spinner.text = chalk.cyan(
        `Processing files (${Math.round(
          (completedSteps / totalSteps) * 100
        )}%) - Package files created`
      );
    })(),
  ]);
  spinner.succeed(chalk.cyan("Files processed (100%)"));

  // Create final ZIP
  spinner.text = chalk.cyan("Creating final package (0%)");
  const files = await fs.readdir(outputDir);
  let zipProgress = 0;
  const totalFiles = files.length;

  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        // Handle directory contents
        const dirFiles = await fs.readdir(filePath);
        await Promise.all(
          dirFiles.map(async (dirFile) => {
            const dirFilePath = path.join(filePath, dirFile);
            const content = await fs.readFile(dirFilePath);
            zip.file(path.join(file, dirFile), content);
            zipProgress++;
            spinner.text = chalk.cyan(
              `Creating final package (${Math.round(
                (zipProgress / totalFiles) * 100
              )}%)`
            );
          })
        );
      } else {
        const content = await fs.readFile(filePath);
        zip.file(file, content);
        zipProgress++;
        spinner.text = chalk.cyan(
          `Creating final package (${Math.round(
            (zipProgress / totalFiles) * 100
          )}%)`
        );
      }
    })
  );

  spinner.text = chalk.cyan("Finalizing package (90%)");
  const zipContent = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(outputPath, zipContent);
  await fs.remove(outputDir);
  spinner.succeed(chalk.cyan("Package created (100%)"));
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
      account,
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
