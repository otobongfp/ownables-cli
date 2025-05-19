const fs = require("fs-extra");
const path = require("path");
const sharp = require("sharp");

async function handleStaticOwnable(projectPath, outputDir, metadata, spinner) {
  const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");
  const imagesDir = path.join(projectPath, "assets/images");
  const images = await fs.readdir(imagesDir);
  const imageFile = images.find((file) => file.startsWith(projectName));

  if (!imageFile) {
    throw new Error(
      `No image file found for project ${projectName} in assets/images`
    );
  }

  // Process images in parallel
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

  return {
    imageFile,
    type: "image",
  };
}

async function handleMusicOwnable(projectPath, outputDir, metadata, spinner) {
  const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");

  // Check for required files in parallel
  const [audioDir, imagesDir] = await Promise.all([
    fs.pathExists(path.join(projectPath, "assets/audio")),
    fs.pathExists(path.join(projectPath, "assets/images")),
  ]);

  if (!audioDir) {
    throw new Error("No audio directory found in assets");
  }

  if (!imagesDir) {
    throw new Error("No images directory found in assets");
  }

  // Read directories in parallel
  const [audioFiles, images] = await Promise.all([
    fs.readdir(path.join(projectPath, "assets/audio")),
    fs.readdir(path.join(projectPath, "assets/images")),
  ]);

  const musicFile = audioFiles.find((file) =>
    file.toLowerCase().endsWith(".mp3")
  );

  if (!musicFile) {
    throw new Error("No music.mp3 file found in assets/audio directory");
  }

  if (images.length < 2) {
    throw new Error(
      "At least two images are required in assets/images directory"
    );
  }

  // Use the first two images found
  const [coverArt, backdrop] = images.slice(0, 2);

  // Process all files in parallel
  await Promise.all([
    // Copy audio file
    fs.copy(
      path.join(projectPath, "assets/audio", musicFile),
      path.join(outputDir, "audio", musicFile)
    ),
    // Copy and process images
    fs.copy(
      path.join(projectPath, "assets/images", coverArt),
      path.join(outputDir, "images", coverArt)
    ),
    fs.copy(
      path.join(projectPath, "assets/images", backdrop),
      path.join(outputDir, "images", backdrop)
    ),
    // Create thumbnail from cover art
    sharp(path.join(projectPath, "assets/images", coverArt))
      .resize(300, 300, { fit: "inside" })
      .webp({ quality: 80 })
      .toFile(path.join(outputDir, "thumbnail.webp")),
  ]);

  return {
    audioFile: musicFile,
    coverArt,
    backdrop,
    type: "music",
  };
}

async function getOwnableType(projectPath) {
  const typePath = path.join(projectPath, "type.txt");
  if (!fs.existsSync(typePath)) {
    throw new Error("No type.txt found in project directory");
  }
  return fs.readFile(typePath, "utf8");
}

module.exports = {
  handleStaticOwnable,
  handleMusicOwnable,
  getOwnableType,
};
