# Scripts

## install.sh - Auto-Installer for Debian and RHEL-based Systems

This script automatically downloads and installs the latest Psysonic release from GitHub Releases.

### Supported Distributions

- **Debian/Ubuntu**: Downloads and installs `.deb` package
- **RHEL/Fedora/CentOS**: Downloads and installs `.rpm` package

### Usage

#### Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Psysonic/psysonic/main/scripts/install.sh | sudo bash
```

#### Manual Installation

```bash
# Download the script
wget https://raw.githubusercontent.com/Psysonic/psysonic/main/scripts/install.sh

# Make it executable
chmod +x install.sh

# Run with sudo
sudo ./install.sh
```

### What it does

1. Detects your OS type (Debian or RHEL-based)
2. Fetches the latest release from GitHub
3. Downloads the appropriate package (.deb or .rpm)
4. Installs it using your system's package manager
5. Cleans up temporary files

### Requirements

- `curl` - for downloading packages
- `sudo` or root access
- Internet connection
- Supported package manager (apt-get, dnf, or yum)

### Notes

- If Psysonic is already installed, the script will ask if you want to reinstall
- The script automatically handles dependency installation for Debian systems
- After installation, you can launch Psysonic from your application menu or by running `psysonic` in the terminal
