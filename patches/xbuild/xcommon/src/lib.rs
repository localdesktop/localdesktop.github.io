pub mod llvm;

use anyhow::{Context, Result};
use byteorder::{LittleEndian, ReadBytesExt};
use image::imageops::FilterType;
use image::io::Reader as ImageReader;
use image::{DynamicImage, GenericImageView, ImageOutputFormat, RgbaImage};
use rsa::pkcs8::DecodePrivateKey;
use rsa::{PaddingScheme, RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub use rasn_pkix::Certificate;
pub use zip::read::ZipFile;

pub struct Scaler {
    img: DynamicImage,
}

impl Scaler {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref();
        let img = ImageReader::open(path)
            .with_context(|| format!("Scaler failed to open image at `{}`", path.display()))?
            .decode()?;
        let (width, height) = img.dimensions();
        anyhow::ensure!(width == height, "expected width == height");
        anyhow::ensure!(width >= 512, "expected icon of at least 512x512 px");
        Ok(Self { img })
    }

    pub fn optimize(&mut self) {
        let mut is_grayscale = true;
        let mut is_opaque = true;
        let (width, height) = self.img.dimensions();
        for x in 0..width {
            for y in 0..height {
                let pixel = self.img.get_pixel(x, y);
                if pixel[0] != pixel[1] || pixel[1] != pixel[2] {
                    is_grayscale = false;
                }
                if pixel[3] != 255 {
                    is_opaque = false;
                }
                if !is_grayscale && !is_opaque {
                    break;
                }
            }
        }
        match (is_grayscale, is_opaque) {
            (true, true) => self.img = DynamicImage::ImageLuma8(self.img.to_luma8()),
            (true, false) => self.img = DynamicImage::ImageLumaA8(self.img.to_luma_alpha8()),
            (false, true) => self.img = DynamicImage::ImageRgb8(self.img.to_rgb8()),
            (false, false) => {}
        }
    }

    pub fn write<W: Write + Seek>(&self, w: &mut W, opts: ScalerOpts) -> Result<()> {
        let resized = self
            .img
            .resize(opts.scaled_size, opts.scaled_size, FilterType::Nearest);
        if opts.scaled_size == opts.target_width && opts.scaled_size == opts.target_height {
            resized.write_to(w, ImageOutputFormat::Png)?;
        } else {
            let x = (opts.target_width - opts.scaled_size) / 2;
            let y = (opts.target_height - opts.scaled_size) / 2;
            let mut padded = RgbaImage::new(opts.target_width, opts.target_height);
            image::imageops::overlay(&mut padded, &resized, x as i64, y as i64);
            padded.write_to(w, ImageOutputFormat::Png)?;
        }
        Ok(())
    }

    /// Whether the icon has no transparent pixels (after `optimize`).
    pub fn is_opaque(&self) -> bool {
        !self.img.color().has_alpha()
    }

    /// An adaptive icon layer, `size` px for its 108 dp, with the whole icon in the 72 dp that
    /// launchers show. The icon's edge pixels continue to the layer's edges, so a full-bleed
    /// icon shows no other color around it and a transparent one stays transparent.
    pub fn write_adaptive_layer<W: Write + Seek>(&self, w: &mut W, size: u32) -> Result<()> {
        let inner = size * 2 / 3;
        let offset = (size - inner) / 2;
        let resized = self
            .img
            .resize_exact(inner, inner, FilterType::Lanczos3)
            .to_rgba8();
        let edge = |v: u32| v.saturating_sub(offset).min(inner - 1);
        let layer = RgbaImage::from_fn(size, size, |x, y| *resized.get_pixel(edge(x), edge(y)));
        layer.write_to(w, ImageOutputFormat::Png)?;
        Ok(())
    }

    pub fn to_vec(&self, opts: ScalerOpts) -> Vec<u8> {
        let mut buf = vec![];
        let mut cursor = Cursor::new(&mut buf);
        self.write(&mut cursor, opts).unwrap();
        buf
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScalerOptsBuilder {
    width: u32,
    height: u32,
    scale: f32,
    padding: f32,
}

impl ScalerOptsBuilder {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            scale: 1.0,
            padding: 0.0,
        }
    }

    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }

    pub fn padding(mut self, percent: f32) -> Self {
        self.padding = percent;
        self
    }

    pub fn build(self) -> ScalerOpts {
        let target_width = (self.width as f32 * self.scale) as u32;
        let target_height = (self.height as f32 * self.scale) as u32;
        let unpadded_size = std::cmp::min(target_width, target_height);
        let scaled_size = (unpadded_size as f32 - (unpadded_size as f32 * self.padding)) as u32;
        ScalerOpts {
            target_width,
            target_height,
            scaled_size,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScalerOpts {
    target_width: u32,
    target_height: u32,
    scaled_size: u32,
}

impl ScalerOpts {
    pub fn new(size: u32) -> Self {
        Self {
            target_width: size,
            target_height: size,
            scaled_size: size,
        }
    }
}

#[derive(Clone)]
pub struct Signer {
    key: RsaPrivateKey,
    pubkey: RsaPublicKey,
    cert: Certificate,
}

impl Signer {
    /// Creates a new signer using a private key and a certificate.
    ///
    /// A new self signed certificate can be generated using openssl:
    /// ```sh
    /// openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem
    /// cat cert.pem > pem
    /// cat key.pem >> pem
    /// ```
    pub fn new(pem: &str) -> Result<Self> {
        let pem = pem::parse_many(pem)?;
        let key = if let Some(key) = pem.iter().find(|pem| pem.tag == "PRIVATE KEY") {
            RsaPrivateKey::from_pkcs8_der(&key.contents)?
        } else {
            anyhow::bail!("no private key found");
        };
        let cert = if let Some(cert) = pem.iter().find(|pem| pem.tag == "CERTIFICATE") {
            rasn::der::decode::<Certificate>(&cert.contents)
                .map_err(|err| anyhow::anyhow!("{}", err))?
        } else {
            anyhow::bail!("no certificate found");
        };
        let pubkey = RsaPublicKey::from(&key);
        Ok(Self { key, pubkey, cert })
    }

    pub fn from_path(path: &Path) -> Result<Self> {
        Self::new(&std::fs::read_to_string(path)?)
    }

    pub fn sign(&self, bytes: &[u8]) -> Vec<u8> {
        let digest = Sha256::digest(bytes);
        let padding = PaddingScheme::new_pkcs1v15_sign::<sha2::Sha256>();
        self.key.sign(padding, &digest).unwrap()
    }

    pub fn pubkey(&self) -> &RsaPublicKey {
        &self.pubkey
    }

    pub fn key(&self) -> &RsaPrivateKey {
        &self.key
    }

    pub fn cert(&self) -> &Certificate {
        &self.cert
    }
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.debug_struct("Signer")
            .field("pubkey", &self.pubkey)
            .field("cert", &self.cert)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ZipFileOptions {
    Unaligned,
    Aligned(u16),
    Compressed,
}

impl ZipFileOptions {
    pub fn alignment(self) -> u16 {
        match self {
            Self::Aligned(align) => align,
            _ => 1,
        }
    }

    pub fn compression_method(&self) -> CompressionMethod {
        match self {
            Self::Compressed => CompressionMethod::Deflated,
            _ => CompressionMethod::Stored,
        }
    }
}

pub struct ZipInfo {
    pub cde_start: u64,
    pub cd_start: u64,
}

impl ZipInfo {
    pub fn new<R: Read + Seek>(r: &mut R) -> Result<Self> {
        let cde_start = find_cde_start_pos(r)?;
        r.seek(SeekFrom::Start(cde_start + 16))?;
        let cd_start = r.read_u32::<LittleEndian>()? as u64;
        Ok(Self {
            cde_start,
            cd_start,
        })
    }
}

// adapted from zip-rs
fn find_cde_start_pos<R: Read + Seek>(reader: &mut R) -> Result<u64> {
    const CENTRAL_DIRECTORY_END_SIGNATURE: u32 = 0x06054b50;
    const HEADER_SIZE: u64 = 22;
    let file_length = reader.seek(SeekFrom::End(0))?;
    let search_upper_bound = file_length.saturating_sub(HEADER_SIZE + u16::MAX as u64);
    anyhow::ensure!(file_length >= HEADER_SIZE, "Invalid zip header");
    let mut pos = file_length - HEADER_SIZE;
    while pos >= search_upper_bound {
        reader.seek(SeekFrom::Start(pos))?;
        if reader.read_u32::<LittleEndian>()? == CENTRAL_DIRECTORY_END_SIGNATURE {
            return Ok(pos);
        }
        pos = match pos.checked_sub(1) {
            Some(p) => p,
            None => break,
        };
    }
    anyhow::bail!("Could not find central directory end");
}

pub struct Zip {
    zip: ZipWriter<File>,
    compress: bool,
}

impl Zip {
    pub fn new(path: &Path, compress: bool) -> Result<Self> {
        Ok(Self {
            zip: ZipWriter::new(File::create(path)?),
            compress,
        })
    }

    pub fn append(path: &Path, compress: bool) -> Result<Self> {
        let f = OpenOptions::new().read(true).write(true).open(path)?;
        Ok(Self {
            zip: ZipWriter::new_append(f)?,
            compress,
        })
    }

    pub fn add_file(&mut self, source: &Path, dest: &Path, opts: ZipFileOptions) -> Result<()> {
        let mut f = File::open(source)
            .with_context(|| format!("While opening file `{}`", source.display()))?;
        self.start_file(dest, opts)?;
        std::io::copy(&mut f, &mut self.zip)?;
        Ok(())
    }

    pub fn add_directory(
        &mut self,
        source: &Path,
        dest: &Path,
        opts: ZipFileOptions,
    ) -> Result<()> {
        add_recursive(self, source, dest, opts)?;
        Ok(())
    }

    pub fn add_zip_file(&mut self, f: ZipFile) -> Result<()> {
        self.zip.raw_copy_file(f)?;
        Ok(())
    }

    pub fn create_file(
        &mut self,
        dest: &Path,
        opts: ZipFileOptions,
        contents: &[u8],
    ) -> Result<()> {
        self.start_file(dest, opts)?;
        self.zip.write_all(contents)?;
        Ok(())
    }

    pub fn start_file(&mut self, dest: &Path, opts: ZipFileOptions) -> Result<()> {
        let name = dest
            .iter()
            .map(|seg| seg.to_str().unwrap())
            .collect::<Vec<_>>()
            .join("/");
        let compression_method = if self.compress {
            opts.compression_method()
        } else {
            CompressionMethod::Stored
        };
        let zopts = FileOptions::default().compression_method(compression_method);
        self.zip.start_file_aligned(name, zopts, opts.alignment())?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        self.zip.finish()?;
        Ok(())
    }
}

fn add_recursive(zip: &mut Zip, source: &Path, dest: &Path, opts: ZipFileOptions) -> Result<()> {
    for entry in std::fs::read_dir(source)
        .with_context(|| format!("While reading directory `{}`", source.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let source = source.join(&file_name);
        let dest = dest.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            add_recursive(zip, &source, &dest, opts)?;
        } else if file_type.is_file() {
            zip.add_file(&source, &dest, opts)?;
        }
    }
    Ok(())
}

impl Write for Zip {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.zip.write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.zip.flush()
    }
}

pub fn copy_dir_all(source: &Path, dest: &Path) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let source = source.join(&file_name);
        let dest = dest.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&dest)?;
            copy_dir_all(&source, &dest)?;
        } else if file_type.is_file() {
            std::fs::copy(&source, &dest)?;
        } else if file_type.is_symlink() {
            let target = std::fs::read_link(&source)?;
            symlink(&target, &dest)?;
        }
    }
    Ok(())
}

pub fn symlink(target: &Path, dest: &Path) -> Result<()> {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, dest)?;
    #[cfg(windows)]
    if dest.is_dir() {
        std::os::windows::fs::symlink_dir(target, dest)?;
    } else {
        std::os::windows::fs::symlink_file(target, dest)?;
    }
    Ok(())
}

pub fn is_stamp_dirty(file: &Path, stamp: &Path) -> Result<bool> {
    if !stamp.exists() {
        return Ok(true);
    }
    let stamp_time = std::fs::metadata(stamp)?.modified()?;
    let file_time = std::fs::metadata(file)?.modified()?;
    Ok(file_time > stamp_time)
}

pub fn create_stamp(stamp: &Path) -> Result<()> {
    if let Some(parent) = stamp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    File::create(stamp)?;
    Ok(())
}

fn get_symlink_source(entry: &mut ZipFile<'_>) -> Result<Option<PathBuf>> {
    if let Some(mode) = entry.unix_mode() {
        const S_IFLNK: u32 = 0o120000; // symbolic link
        if mode & S_IFLNK == S_IFLNK {
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents)?;
            let contents = Path::new(std::str::from_utf8(&contents)?);
            return Ok(Some(contents.into()));
        }
    }
    Ok(None)
}

pub fn extract_zip(archive: &Path, directory: &Path) -> Result<()> {
    let mut archive = ZipArchive::new(File::open(archive)?)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let filepath = file.enclosed_name().context("Invalid file path")?;

        let outpath = directory.join(filepath);

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)?;
                }
            }
            if let Some(target) = get_symlink_source(&mut file)? {
                symlink(&target, &outpath)?;
            } else {
                let mut outfile = File::create(&outpath)?;
                std::io::copy(&mut file, &mut outfile)?;

                // Get and Set permissions
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = file.unix_mode() {
                        std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode))?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn extract_zip_file(archive: &Path, name: &str) -> Result<Vec<u8>> {
    let mut archive = ZipArchive::new(File::open(archive)?)?;
    let mut f = archive.by_name(name)?;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str = include_str!("../assets/test.pem");

    #[test]
    fn create_signer() {
        Signer::new(PEM).unwrap();
    }
}
