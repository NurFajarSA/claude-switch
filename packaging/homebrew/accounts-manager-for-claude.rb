# typed: strict
# frozen_string_literal: true

# Template for Casks/accounts-manager-for-claude.rb in the NurFajarSA/homebrew-tap repository.
# After a release is published, scripts/update-cask.sh <version> <tap-checkout> fills in the checksum and copies it there.
cask "accounts-manager-for-claude" do
  version "1.1.0"
  sha256 "7fd7693c5a6068c71e8b3da668532a408ed490a43942138da339d58328e7c62c"

  url "https://github.com/NurFajarSA/claude-switch/releases/download/v#{version}/AccountsManager-#{version}-macos-arm64.zip"
  name "Accounts Manager for Claude"
  desc "Run several Claude accounts and switch before one hits its limit"
  homepage "https://github.com/NurFajarSA/claude-switch"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "Accounts Manager for Claude.app"
  binary "#{appdir}/Accounts Manager for Claude.app/Contents/Resources/cs"

  # Releases without a Developer ID are ad-hoc signed. Without this, Gatekeeper blocks the app
  # and silently kills the bundled cs, so the poller and hooks never run.
  postflight_steps do
    run "/usr/bin/xattr", args:         ["-dr", "com.apple.quarantine", "{{appdir}}/Accounts Manager for Claude.app"],
                          must_succeed: false
  end

  uninstall launchctl: ["app.claude-switch.daemon", "app.claude-switch.menubar"],
            quit:      "app.claude-switch.menubar"

  zap trash: "~/.config/claude-switch"

  caveats <<~EOS
    Set up the background poller, MCP server and Claude Code hooks, and run this again after every upgrade:
      cs install --app "#{appdir}/Accounts Manager for Claude.app"

    Before uninstalling, remove the hooks, MCP server and ~/.local/bin/cs it added:
      cs uninstall
  EOS
end
