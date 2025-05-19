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

  // Check if wasm-bindgen is installed
  if (!shell.which("wasm-bindgen")) {
    throw new Error(
      "wasm-bindgen is not installed. Please install it with: cargo install wasm-bindgen-cli"
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

async function buildWasm(projectPath, spinner) {
  // Read project name from Cargo.toml
  const cargoToml = fs.readFileSync(
    path.join(projectPath, "Cargo.toml"),
    "utf8"
  );
  const projectName = cargoToml.match(/name = "([^"]+)"/)[1];

  // Build with cargo and wasm-bindgen in one step
  try {
    spinner.text = chalk.cyan("Building WebAssembly (0%)");
    const { stdout: buildStdout, stderr: buildStderr } = await execAsync(
      "cargo build --target wasm32-unknown-unknown --release",
      {
        cwd: projectPath,
        env: {
          ...process.env,
          RUSTFLAGS: "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
          CARGO_HTTP_MULTIPLEXING: "false",
          CC: "clang",
          CXX: "clang++",
        },
      }
    );

    if (buildStderr) {
      console.error("Build stderr:", buildStderr);
    }
    if (buildStdout) {
      // Parse cargo output for progress
      const lines = buildStdout.split("\n");
      for (const line of lines) {
        if (line.includes("Compiling")) {
          spinner.text = chalk.cyan(`Building WebAssembly (${line.trim()})`);
        }
      }
    }

    spinner.text = chalk.cyan("Generating JavaScript bindings (50%)");
    // Run wasm-bindgen to generate JS bindings
    const wasmPath = path.join(
      projectPath,
      "target/wasm32-unknown-unknown/release",
      `${projectName}.wasm`
    );

    const { stdout: bindgenStdout, stderr: bindgenStderr } = await execAsync(
      `wasm-bindgen ${wasmPath} --out-dir ${path.join(
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

  // Process all files in parallel
  spinner.text = chalk.cyan("Processing files...");
  await Promise.all([
    // Copy and process WASM/JS files
    (async () => {
      await fs.copy(
        path.join(
          projectPath,
          "target/wasm32-unknown-unknown/release",
          `${projectName}_bg.wasm`
        ),
        path.join(outputDir, "ownable_bg.wasm")
      );
      await fs.copy(
        path.join(
          projectPath,
          "target/wasm32-unknown-unknown/release",
          `${projectName}.js`
        ),
        path.join(outputDir, "ownable.js")
      );
    })(),

    // Process images
    (async () => {
      const imagePath = path.join(projectPath, "assets/images", imageFile);
      await fs.copy(imagePath, path.join(outputDir, imageFile));
      await sharp(imagePath)
        .resize(300, 300, { fit: "inside" })
        .webp({ quality: 80 })
        .toFile(path.join(outputDir, "thumbnail.webp"));
    })(),

    // Generate and copy schema files
    (async () => {
      const schemaDir = path.join(projectPath, "schema");
      if (!fs.existsSync(schemaDir)) {
        fs.mkdirSync(schemaDir, { recursive: true });
      }

      await execAsync("cargo run --example schema --release", {
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

      for (const file of schemaFiles) {
        const schemaPath = path.join(schemaDir, file);
        if (fs.existsSync(schemaPath)) {
          await fs.copy(schemaPath, path.join(outputDir, file));
        }
      }
    })(),

    // Process index.html
    (async () => {
      const sourceIndexHtml = path.join(projectPath, "assets", "index.html");
      if (!fs.existsSync(sourceIndexHtml)) {
        throw new Error("No index.html found in assets directory");
      }
      let indexHtmlContent = await fs.readFile(sourceIndexHtml, "utf8");
      // Replace both src=images/ and src="images/" patterns
      indexHtmlContent = indexHtmlContent.replace(
        /src=["']?images\//g,
        'src="'
      );
      // Ensure all image sources have proper quotes
      indexHtmlContent = indexHtmlContent.replace(
        /src=([^"'\s>]+)/g,
        'src="$1"'
      );
      await fs.writeFile(path.join(outputDir, "index.html"), indexHtmlContent);
    })(),

    // Create package files
    (async () => {
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

      await fs.writeJson(path.join(outputDir, "package.json"), packageJson, {
        spaces: 2,
      });
      await fs.writeJson(
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
      );
    })(),

    // Create chain.json
    (async () => {
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
    })(),
  ]);
  spinner.succeed(chalk.cyan("Files processed"));

  // Create final ZIP
  spinner.text = chalk.cyan("Creating final package...");
  const files = await fs.readdir(outputDir);
  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const stats = await fs.stat(filePath);
    if (stats.isFile()) {
      const content = await fs.readFile(filePath);
      zip.file(file, content);
    }
  }

  const zipContent = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(outputPath, zipContent);
  await fs.remove(outputDir);
  spinner.succeed(chalk.cyan("Package created"));
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
    spinner.text = chalk.cyan("Checking environment...");
    await Promise.all([checkPrerequisites(), checkProjectStructure()]);
    spinner.succeed(chalk.cyan("Environment ready"));

    // Build and optimize WASM
    spinner.text = chalk.cyan("Building WebAssembly...");
    const { wasmPath, jsPath } = await buildWasm(process.cwd(), spinner);
    await optimizeWasm(spinner);
    spinner.succeed(chalk.cyan("WebAssembly ready"));

    // Get metadata and create LTO account
    spinner.text = chalk.cyan("Preparing package...");
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
