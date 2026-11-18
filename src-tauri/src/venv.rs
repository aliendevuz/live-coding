//! Python virtual environments, activated the way VS Code does it: the venv's
//! scripts folder goes first on PATH and VIRTUAL_ENV is set. Then `python`,
//! `pip` and a notebook's `!pip install` all use the project's environment
//! instead of the global Python.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const BIN: &str = "Scripts";
#[cfg(not(windows))]
const BIN: &str = "bin";
#[cfg(windows)]
const PY: &str = "python.exe";
#[cfg(not(windows))]
const PY: &str = "python";

/// The venv in a project folder (.venv, venv or env), if any.
pub fn find_in(project: &Path) -> Option<PathBuf> {
    [".venv", "venv", "env"]
        .iter()
        .map(|v| project.join(v))
        .find(|v| v.join("pyvenv.cfg").is_file() && v.join(BIN).join(PY).is_file())
}

/// The venv a python executable belongs to (…/venv/Scripts/python.exe).
pub fn of_python(python: &str) -> Option<PathBuf> {
    let p = Path::new(python);
    let root = p.parent()?.parent()?;
    root.join("pyvenv.cfg").is_file().then(|| root.to_path_buf())
}

/// The name PATH has in this process's environment ("Path" on Windows).
fn path_key() -> String {
    std::env::vars_os()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .find(|k| k.eq_ignore_ascii_case("PATH"))
        .unwrap_or_else(|| "PATH".into())
}

/// (PATH key, PATH value with the venv first, VIRTUAL_ENV value).
pub fn activation(venv: &Path) -> (String, OsString, OsString) {
    let key = path_key();
    let mut dirs = vec![venv.join(BIN)];
    if let Some(cur) = std::env::var_os(&key) {
        dirs.extend(std::env::split_paths(&cur));
    }
    let path = std::env::join_paths(dirs).unwrap_or_default();
    (key, path, venv.as_os_str().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_and_activates_a_venv() {
        let tmp = std::env::temp_dir().join("duet-venv-test");
        let _ = std::fs::remove_dir_all(&tmp);
        let venv = tmp.join(".venv");
        std::fs::create_dir_all(venv.join(BIN)).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = x\n").unwrap();
        std::fs::write(venv.join(BIN).join(PY), "").unwrap();

        assert_eq!(find_in(&tmp).as_deref(), Some(venv.as_path()));
        let py = venv.join(BIN).join(PY);
        assert_eq!(of_python(py.to_str().unwrap()).as_deref(), Some(venv.as_path()));
        assert_eq!(of_python("python"), None);

        let (_, path, ve) = activation(&venv);
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, venv.join(BIN), "venv scripts must come first on PATH");
        assert_eq!(ve, venv.as_os_str());
    }
}
