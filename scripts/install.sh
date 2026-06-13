#!/bin/bash
set -e

# Psysonic Auto-Installer
# Automatically detects your OS and installs the latest release from GitHub

REPO="Psychotoxical/psysonic"
APP_NAME="psysonic"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log helpers write to stderr so functions that return values via stdout
# (e.g. get_download_url) stay clean when called in command substitution.
info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    exit 1
}

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "Please run this script as root (use sudo)"
    fi
}

# Detect package manager and OS type
detect_os() {
    if command -v apt &> /dev/null; then
        OS_TYPE="debian"
        PACKAGE_MANAGER="apt"
        info "Detected Debian/Ubuntu-based system (apt)"
    elif command -v dnf &> /dev/null; then
        OS_TYPE="rhel"
        PACKAGE_MANAGER="dnf"
        info "Detected RHEL/Fedora-based system (dnf)"
    elif command -v yum &> /dev/null; then
        OS_TYPE="rhel"
        PACKAGE_MANAGER="yum"
        info "Detected RHEL/CentOS-based system (yum)"
    else
        error "Unsupported package manager. This installer supports Debian/Ubuntu and RHEL/Fedora/CentOS systems."
    fi
}

# Get the latest release download URL for the specific package type
get_download_url() {
    local api_url="https://api.github.com/repos/${REPO}/releases/latest"
    
    info "Fetching latest release information..."
    
    local release_info
    release_info=$(curl -s "$api_url")
    
    if echo "$release_info" | grep -q "message.*Not Found"; then
        error "Could not fetch release information. Please check your internet connection."
    fi
    
    local tag_name
    tag_name=$(echo "$release_info" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$tag_name" ]; then
        error "Could not determine latest release version."
    fi
    
    info "Latest version: $tag_name"
    
    local download_url=""
    
    if [ "$OS_TYPE" = "debian" ]; then
        download_url=$(echo "$release_info" | grep -o '"browser_download_url": *"[^"]*\.deb"' | head -1 | cut -d'"' -f4)
    elif [ "$OS_TYPE" = "rhel" ]; then
        download_url=$(echo "$release_info" | grep -o '"browser_download_url": *"[^"]*\.rpm"' | head -1 | cut -d'"' -f4)
    fi
    
    if [ -z "$download_url" ]; then
        error "Could not find download URL for $OS_TYPE package."
    fi
    
    echo "$download_url"
}

# Install the package
install_package() {
    local download_url="$1"
    local temp_dir
    temp_dir=$(mktemp -d)
    local package_file="$temp_dir/${APP_NAME}_latest"
    
    info "Downloading package..."
    
    if [ "$OS_TYPE" = "debian" ]; then
        package_file="${package_file}.deb"
        curl --fail --globoff -L -o "$package_file" "$download_url"
        
        info "Installing package..."
        $PACKAGE_MANAGER install -y "$package_file" || {
            warn "Trying to fix broken dependencies..."
            $PACKAGE_MANAGER install -f -y
        }
    elif [ "$OS_TYPE" = "rhel" ]; then
        package_file="${package_file}.rpm"
        curl --fail --globoff -L -o "$package_file" "$download_url"
        
        info "Installing package..."
        $PACKAGE_MANAGER install -y "$package_file"
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
}

# Check if app is already installed
check_installed() {
    if command -v $APP_NAME &> /dev/null || command -v ${APP_NAME^} &> /dev/null; then
        warn "${APP_NAME} appears to be already installed."
        # Under `curl ... | bash`, stdin is the script stream itself, so
        # read the answer from the controlling terminal instead. Probe by
        # opening: `[ -r /dev/tty ]` passes on the 0666 device node even
        # without a controlling terminal; only open() reports the failure.
        if { : < /dev/tty; } 2>/dev/null; then
            read -p "Do you want to reinstall? (y/N): " -n 1 -r < /dev/tty
            echo
        else
            warn "No terminal available for prompt; skipping reinstall."
            exit 0
        fi
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            info "Installation cancelled."
            exit 0
        fi
    fi
}

# Main installation flow
main() {
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║           Psysonic Auto-Installer                        ║"
    echo "║   Install the latest release from GitHub Releases        ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    check_root
    detect_os
    check_installed
    
    local download_url
    download_url=$(get_download_url)
    
    if [ -z "$download_url" ]; then
        error "Failed to get download URL."
    fi
    
    info "Download URL: $download_url"
    
    install_package "$download_url"
    
    echo ""
    success "Psysonic has been installed successfully!"
    echo -e "${BLUE}You can launch it from your application menu or by running:${NC} psysonic"
    echo ""
}

# Run main function
main
