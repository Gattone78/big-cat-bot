# Control the big-cat voice stack on gpu-vm from the workstation.
#
#   .\deploy\stack.ps1 status              # containers + GPU memory
#   .\deploy\stack.ps1 down                # stop everything (VM stays up)
#   .\deploy\stack.ps1 up                  # start everything
#   .\deploy\stack.ps1 down vllm           # stop one service (frees its VRAM)
#   .\deploy\stack.ps1 up vllm             # start one service
#   .\deploy\stack.ps1 restart tts
#   .\deploy\stack.ps1 logs vllm           # last 40 log lines
#
# Uses the passwordless `sudo nerdctl` rule on the VM, so nothing prompts.
# The big-cat-stack systemd unit still brings everything up on VM boot;
# `down` here only lasts until the next VM reboot.
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'status', 'restart', 'logs')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [ValidateSet('', 'vllm', 'stt', 'tts', 'tts-kokoro')]
    [string]$Service = ''
)

$compose = 'cd ~/big-cat/deploy && sudo -n nerdctl compose'

switch ($Command) {
    'up' {
        ssh gpu "$compose up -d $Service"
    }
    'down' {
        if ($Service) { ssh gpu "$compose stop $Service" }
        else { ssh gpu "$compose down" }
    }
    'restart' {
        ssh gpu "$compose restart $Service"
    }
    'logs' {
        ssh gpu "$compose logs --tail 40 $Service"
    }
    'status' {
        ssh gpu "$compose ps 2>/dev/null; echo; nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader; nvidia-smi --query-compute-apps=used_memory --format=csv,noheader"
    }
}
exit $LASTEXITCODE
