# Power-control the GPU VM itself from the workstation, via the Proxmox API.
#
#   .\deploy\vm.ps1 status      # running / stopped
#   .\deploy\vm.ps1 start       # boot the VM (voice stack auto-starts via systemd)
#   .\deploy\vm.ps1 shutdown    # graceful ACPI shutdown (stack stops cleanly first)
#   .\deploy\vm.ps1 stop        # hard power-off (last resort)
#
# One-time setup (Proxmox web UI):
#   1. Datacenter -> Permissions -> API Tokens -> Add
#      (e.g. user root@pam, token id "bigcat", keep "Privilege Separation" checked)
#   2. Datacenter -> Permissions -> Add -> API Token Permission
#      path: /vms/<vmid of the GPU VM>   token: root@pam!bigcat   role: PVEVMUser
#   3. Copy deploy/vm.env.example to deploy/vm.env (gitignored) and fill it in.
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'shutdown', 'stop')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

# config: deploy/vm.env, overridable by environment variables of the same name
$cfg = @{}
$envFile = Join-Path $PSScriptRoot 'vm.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') {
            $cfg[$Matches[1]] = $Matches[2]
        }
    }
}
foreach ($k in 'PVE_URL', 'PVE_TOKEN', 'PVE_VM') {
    $ov = [Environment]::GetEnvironmentVariable($k)
    if ($ov) { $cfg[$k] = $ov }
    if (-not $cfg[$k]) { throw "$k not set - copy deploy/vm.env.example to deploy/vm.env and fill it in" }
}

function Invoke-Pve([string]$Method, [string]$Path) {
    # curl.exe -k: Proxmox ships a self-signed certificate by default
    $raw = curl.exe -ksS -X $Method -H "Authorization: PVEAPIToken=$($cfg.PVE_TOKEN)" "$($cfg.PVE_URL)/api2/json$Path"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "no response from $($cfg.PVE_URL)" }
    $json = $raw | ConvertFrom-Json
    if ($null -eq $json.data) { throw "Proxmox API error: $raw" }
    $json.data
}

# resolve node + vmid by VM name, so vm.env only needs the name
$vm = Invoke-Pve GET '/cluster/resources?type=vm' | Where-Object { $_.name -eq $cfg.PVE_VM }
if (-not $vm) { throw "VM '$($cfg.PVE_VM)' not visible - check the name and that the token has PVEVMUser on its /vms/<vmid> path" }
$base = "/nodes/$($vm.node)/qemu/$($vm.vmid)/status"

switch ($Command) {
    'status' {
        "{0} (vmid {1} on {2}): {3}" -f $vm.name, $vm.vmid, $vm.node, $vm.status
    }
    'start' {
        if ($vm.status -eq 'running') { "already running"; break }
        Invoke-Pve POST "$base/start" | Out-Null
        "start requested - the voice stack auto-starts via systemd; give vLLM ~3-5 min, then: .\deploy\stack.ps1 status"
    }
    'shutdown' {
        if ($vm.status -ne 'running') { "not running (status: $($vm.status))"; break }
        Invoke-Pve POST "$base/shutdown" | Out-Null
        "graceful shutdown requested - systemd stops the stack, then the VM powers off"
    }
    'stop' {
        Invoke-Pve POST "$base/stop" | Out-Null
        "hard stop requested"
    }
}
