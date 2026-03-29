# awacs-tray.ps1 — System tray client for AWACS

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AWACS_URL = "http://localhost:7777"

# --- Icon (draws a simple radar dot) ---
$bitmap = New-Object System.Drawing.Bitmap(16, 16)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = "AntiAlias"
$g.Clear([System.Drawing.Color]::FromArgb(30, 30, 30))
$g.FillEllipse([System.Drawing.Brushes]::LimeGreen, 3, 3, 10, 10)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

# --- Tray setup ---
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = "AWACS"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$dashboard = New-Object System.Windows.Forms.ToolStripMenuItem("Open Dashboard")
$dashboard.Add_Click({ Start-Process "$AWACS_URL" })
[void]$menu.Items.Add($dashboard)

$quit = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")
$quit.Add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quit)

$tray.ContextMenuStrip = $menu

# --- Left-click opens dashboard ---
$tray.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process "$AWACS_URL"
    }
})

# Run message loop
[System.Windows.Forms.Application]::Run()
