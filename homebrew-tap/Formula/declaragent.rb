# frozen_string_literal: true

# Homebrew formula for `declaragent`.
#
# Seed template — placeholder tokens (wrapped in double curlies) are
# stamped by the release pipeline before the formula lands in the
# `declaragent/homebrew-tap` repo. See ../README.md for the promotion
# workflow.
#
# The formula serves both macOS arm64 (Apple Silicon) and macOS x64
# (Intel), falling back to the Linux build on Linuxbrew hosts. Every
# download URL points at the GitHub release tarballs produced by
# `.github/workflows/release-binaries.yml`.
class Declaragent < Formula
  desc "Declarative, git-versioned AI agent platform"
  homepage "https://declaragent.dev"
  version "{{VERSION}}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/declaragent/declaragent/releases/download/v#{version}/declaragent-darwin-arm64.tar.gz"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
    on_intel do
      url "https://github.com/declaragent/declaragent/releases/download/v#{version}/declaragent-darwin-x64.tar.gz"
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/declaragent/declaragent/releases/download/v#{version}/declaragent-linux-arm64.tar.gz"
      sha256 "{{SHA256_LINUX_ARM64}}"
    end
    on_intel do
      url "https://github.com/declaragent/declaragent/releases/download/v#{version}/declaragent-linux-x64.tar.gz"
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  def install
    bin.install "declaragent"
  end

  test do
    # Smoke check — `declaragent --help` must exit cleanly and print the
    # usage banner. A broken binary fails this stanza on every formula
    # audit pass (`brew audit`, `brew test-bot`) so it catches the most
    # common regression: a malformed single-executable bundle.
    assert_match "declaragent", shell_output("#{bin}/declaragent --help")
  end
end
