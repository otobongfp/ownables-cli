const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");

async function getTemplateType() {
  return inquirer.prompt([
    {
      type: "list",
      name: "template",
      message: "What type of Ownable would you like to create?",
      choices: [
        {
          name: "Static Ownable - A simple static image or content display",
          value: "static-ownable",
        },
        {
          name: "Music Ownable - Audio with cover art and background image",
          value: "music-ownable",
        },
      ],
    },
  ]);
}

async function getMetadata() {
  return inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "What would you like to name your Ownable?",
      validate: (input) => {
        if (!input) return "Name is required";
        if (!/^[a-z0-9-]+$/.test(input)) {
          return "Name can only contain lowercase letters, numbers, and hyphens";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "description",
      message: "Describe your Ownable:",
      validate: (input) => {
        if (!input) return "Description is required";
        return true;
      },
    },
    {
      type: "input",
      name: "version",
      message: "Version (e.g., 1.0.0):",
      default: "1.0.0",
      validate: (input) => {
        if (!input) return "Version is required";
        if (!/^\d+\.\d+\.\d+$/.test(input)) {
          return "Version must be in format x.y.z";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "authors",
      message: "Authors (comma-separated):",
      validate: (input) => {
        if (!input) return "At least one author is required";
        return true;
      },
    },
    {
      type: "input",
      name: "keywords",
      message: "Keywords (comma-separated):",
      validate: (input) => {
        if (!input) return "At least one keyword is required";
        return true;
      },
    },
  ]);
}

async function replacePlaceholders(filePath, metadata) {
  let content = await fs.readFile(filePath, "utf8");

  // Replace all placeholders with their corresponding values
  content = content
    // Cargo.toml placeholders
    .replace(/PLACEHOLDER1_NAME/g, `"${metadata.name}"`)
    .replace(/PLACEHOLDER1_DESCRIPTION/g, `"${metadata.description}"`)
    .replace(/PLACEHOLDER1_VERSION/g, `"${metadata.version}"`)
    .replace(/PLACEHOLDER1_AUTHORS/g, `"${metadata.authors}"`)
    .replace(
      /PLACEHOLDER1_KEYWORDS/g,
      metadata.keywords
        .split(",")
        .map((k) => `"${k.trim()}"`)
        .join(", ")
    )

    // Contract placeholders
    .replace(/PLACEHOLDER4_CONTRACT_NAME/g, `"${metadata.name}"`)
    .replace(/PLACEHOLDER4_TYPE/g, `"music"`)
    .replace(/PLACEHOLDER4_DESCRIPTION/g, `"${metadata.description}"`)
    .replace(/PLACEHOLDER4_NAME/g, `"${metadata.name}"`)

    // Schema placeholders
    .replace(/PLACEHOLDER3_MSG/g, metadata.name)
    .replace(/PLACEHOLDER3_STATE/g, metadata.name)

    // HTML placeholders
    .replace(/PLACEHOLDER2_TITLE/g, metadata.name)
    .replace(/PLACEHOLDER2_DESCRIPTION/g, metadata.description)
    .replace(/PLACEHOLDER2_COVER/g, "images/cover.jpg")
    .replace(/PLACEHOLDER2_BACKGROUND/g, "images/backdrop.jpg")
    .replace(/PLACEHOLDER2_AUDIO/g, "audio/music.mp3");

  await fs.writeFile(filePath, content);
}

async function create() {
  console.log(chalk.blue("Creating new Ownable template..."));

  // Get template type from user
  const { template } = await getTemplateType();
  console.log(chalk.green("✓ Template type selected"));

  // Get metadata from user
  const metadata = await getMetadata();
  console.log(chalk.green("✓ Metadata collected"));

  // Create project directory
  const projectDir = path.join(process.cwd(), metadata.name);
  if (fs.existsSync(projectDir)) {
    throw new Error(`Directory ${metadata.name} already exists`);
  }

  // Copy template
  const templateDir = path.join(__dirname, "../../templates", template);
  await fs.copy(templateDir, projectDir);

  // Create type.txt to identify the ownable type
  await fs.writeFile(path.join(projectDir, "type.txt"), template);

  // Create assets directory if it doesn't exist
  const assetsDir = path.join(projectDir, "assets");
  await fs.ensureDir(assetsDir);

  // Create images directory
  const imagesDir = path.join(assetsDir, "images");
  await fs.ensureDir(imagesDir);

  // Create audio directory for music ownable
  if (template === "music-ownable") {
    const audioDir = path.join(assetsDir, "audio");
    await fs.ensureDir(audioDir);
  }

  // Replace placeholders in all relevant files
  const filesToUpdate = [
    path.join(projectDir, "Cargo.toml"),
    path.join(projectDir, "src", "contract.rs"),
    path.join(projectDir, "src", "msg.rs"),
    path.join(projectDir, "src", "state.rs"),
    path.join(projectDir, "src", "error.rs"),
    path.join(projectDir, "src", "lib.rs"),
    path.join(projectDir, "examples", "schema.rs"),
    path.join(assetsDir, "index.html"),
  ];

  for (const file of filesToUpdate) {
    if (fs.existsSync(file)) {
      await replacePlaceholders(file, metadata);
    } else {
      console.warn(
        chalk.yellow(
          `Warning: File ${file} not found, skipping placeholder replacement`
        )
      );
    }
  }

  // Create README.md with instructions
  const readmePath = path.join(projectDir, "README.md");
  const readmeContent =
    template === "music-ownable"
      ? `# ${metadata.name}

${metadata.description}

## Getting Started

1. Add your audio file (music.mp3) to the \`assets/audio\` directory
2. Add your cover art and background images to the \`assets/images\` directory
3. Update \`assets/index.html\` to reference your audio and images
4. Run \`ownables-cli build\` to build your Ownable

## Project Structure

- \`assets/\`: Contains your media files and index.html
  - \`audio/\`: Place your music.mp3 file here
  - \`images/\`: Place your cover art and background images here
  - \`index.html\`: The main display file for your Ownable
- \`src/\`: Source code for the Ownable contract
  - \`contract.rs\`: Main contract implementation
  - \`msg.rs\`: Message definitions
  - \`state.rs\`: State management
  - \`error.rs\`: Error handling
  - \`lib.rs\`: Library entry point
- \`examples/\`: Example usage of the Ownable contract

## Building

To build your Ownable, run:

\`\`\`bash
ownables-cli build
\`\`\`

This will create your Ownable package.
`
      : `# ${metadata.name}

${metadata.description}

## Getting Started

1. Add your image files to the \`assets/images\` directory
2. Update \`assets/index.html\` to reference your image
3. Run \`ownables-cli build\` to build your Ownable

## Project Structure

- \`assets/\`: Contains your image files and index.html
  - \`images/\`: Place your image files here
  - \`index.html\`: The main display file for your Ownable
- \`src/\`: Source code for the Ownable contract
  - \`contract.rs\`: Main contract implementation
  - \`msg.rs\`: Message definitions
  - \`state.rs\`: State management
  - \`error.rs\`: Error handling
  - \`lib.rs\`: Library entry point
- \`examples/\`: Example usage of the Ownable contract

## Building

To build your Ownable, run:

\`\`\`bash
ownables-cli build
\`\`\`

This will create your Ownable package.
`;

  await fs.writeFile(readmePath, readmeContent);

  console.log(chalk.green("\nOwnable template created successfully! 🎉"));
  console.log(chalk.blue("\nNext steps:"));

  if (template === "music-ownable") {
    console.log("1. Add your music.mp3 file to the assets/audio directory");
    console.log(
      "2. Add your cover art and background images to the assets/images directory"
    );
    console.log(
      "3. Update assets/index.html to reference your audio and images"
    );
  } else {
    console.log("1. Add your image files to the assets/images directory");
    console.log(
      "2. Update assets/index.html to reference your image (by default it assumes the image has the same name as the project)"
    );
  }
  console.log("4. Run 'ownables-cli build' to build your Ownable");
}

module.exports = { create };
