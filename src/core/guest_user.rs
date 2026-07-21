use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub const ROOT_USERNAME: &str = "root";

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct GuestUser {
    username: String,
    home_dir: PathBuf,
}

impl GuestUser {
    pub fn resolve(fs_root: &Path, requested_username: &str) -> Self {
        find_in_passwd(fs_root, requested_username)
            .or_else(|| find_in_passwd(fs_root, ROOT_USERNAME))
            .unwrap_or_else(Self::root)
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn guest_home_dir(&self) -> &Path {
        &self.home_dir
    }

    pub fn host_home_dir(&self, fs_root: &Path) -> PathBuf {
        fs_root.join(
            self.home_dir
                .strip_prefix("/")
                .expect("guest home directory must be absolute"),
        )
    }

    fn root() -> Self {
        Self {
            username: ROOT_USERNAME.to_string(),
            home_dir: PathBuf::from("/root"),
        }
    }
}

pub fn repair_account_database_permissions(fs_root: &Path) -> io::Result<()> {
    #[cfg(not(unix))]
    {
        let _ = fs_root;
        return Ok(());
    }

    #[cfg(unix)]
    for relative_path in ["etc/passwd", "etc/group"] {
        let path = fs_root.join(relative_path);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };

        let mut permissions = metadata.permissions();
        if permissions.mode() & 0o777 != 0o644 {
            permissions.set_mode(0o644);
            fs::set_permissions(path, permissions)?;
        }
    }

    #[cfg(unix)]
    return Ok(());
}

fn find_in_passwd(fs_root: &Path, requested_username: &str) -> Option<GuestUser> {
    let passwd = fs::read_to_string(fs_root.join("etc/passwd")).ok()?;

    passwd.lines().find_map(|line| {
        let mut fields = line.splitn(7, ':');
        let username = fields.next()?;
        if username != requested_username {
            return None;
        }

        let home_dir = PathBuf::from(fields.nth(4)?);
        if !is_safe_absolute_path(&home_dir) {
            return None;
        }

        Some(GuestUser {
            username: username.to_string(),
            home_dir,
        })
    })
}

fn is_safe_absolute_path(path: &Path) -> bool {
    let mut components = path.components();
    if components.next() != Some(Component::RootDir) {
        return false;
    }

    let mut has_directory = false;
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return false;
        }
        has_directory = true;
    }
    has_directory
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_passwd(fs_root: &Path) {
        fs::create_dir_all(fs_root.join("etc")).unwrap();
        fs::write(
            fs_root.join("etc/passwd"),
            "root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001::/srv/alice:/bin/bash\n",
        )
        .unwrap();
    }

    #[test]
    fn resolves_an_existing_user_and_home_directory() {
        let dir = tempdir().unwrap();
        write_passwd(dir.path());

        let user = GuestUser::resolve(dir.path(), "alice");

        assert_eq!(user.username(), "alice");
        assert_eq!(user.guest_home_dir(), Path::new("/srv/alice"));
        assert_eq!(user.host_home_dir(dir.path()), dir.path().join("srv/alice"));
    }

    #[test]
    fn falls_back_to_root_when_the_requested_user_is_missing() {
        let dir = tempdir().unwrap();
        write_passwd(dir.path());

        let user = GuestUser::resolve(dir.path(), "missing");

        assert_eq!(user.username(), ROOT_USERNAME);
        assert_eq!(user.guest_home_dir(), Path::new("/root"));
    }

    #[test]
    fn rejects_home_directories_that_escape_the_guest_root() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("etc")).unwrap();
        fs::write(
            dir.path().join("etc/passwd"),
            "root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001::/home/../../tmp:/bin/bash\n",
        )
        .unwrap();

        let user = GuestUser::resolve(dir.path(), "alice");

        assert_eq!(user.username(), ROOT_USERNAME);
    }

    #[cfg(unix)]
    #[test]
    fn repairs_public_account_database_permissions() {
        let dir = tempdir().unwrap();
        write_passwd(dir.path());
        fs::write(dir.path().join("etc/group"), "root:x:0:\n").unwrap();
        fs::set_permissions(
            dir.path().join("etc/passwd"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::set_permissions(
            dir.path().join("etc/group"),
            fs::Permissions::from_mode(0o660),
        )
        .unwrap();

        repair_account_database_permissions(dir.path()).unwrap();

        for relative_path in ["etc/passwd", "etc/group"] {
            let mode = fs::metadata(dir.path().join(relative_path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o644);
        }
    }
}
