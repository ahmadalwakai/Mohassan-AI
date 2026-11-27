# Sync the production model store

ينسخ هذا الإجراء ملفات النماذج المدرجة في السجل من حاسوبك إلى الخادم. يتحقق الخادم من البصمات قبل تبديل المجلد، ويحتفظ بالنسخة السابقة للرجوع إليها. يبيّن الفحص حالة ملفات كل نموذج.

Use Node 24 and `npm ci` in a checkout containing these tools on the PC. Keep the owner's existing model checkout as the source. On the VM, run the scripts from a reviewed, root-owned release with its locked dependencies installed. The examples use `/opt/mohassan/app` as that release. You can use a separate root-owned tooling checkout with the same dependencies and substitute its path in the commands while the current app stays online. Confirm the service uses the store paths in the examples, or substitute its configured `MOHASSAN_MODELS_ROOT` and `MOHASSAN_OCR_MODEL_DIR`. [Council store configuration](MODEL-COUNCIL.md#runtime-and-model-store) · [Linux release prerequisites](../scripts/cloud-linux/README.md#prerequisites)

## Preview on the PC

Run in PowerShell 7 from the tools checkout. Enter the path to the existing checkout that holds the trained artifacts when prompted.

```powershell
$ModelSource = Read-Host 'Path to the existing model source checkout'
$Id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$Name = "model-store-$Id"
$Bundle = "artifacts/$Name"
New-Item -ItemType Directory -Force -Path artifacts | Out-Null

node scripts/models/pack-store.mjs --root $ModelSource --out $Bundle
```

The default dry run reports each model's status and the estimated local disk requirement. Add `--json` to include the full per-file preview. Review the reasons for skipped or incomplete models before using `--write`. An absent artifact describes the selected source, so consult the training records to distinguish an untrained model from missing files. The manifest records each file's size and SHA-256. A pin mismatch or an unresolved declared pin blocks the write. Supply `--ocr-dir` to both pack commands if the active OCR export on the PC lives outside its registered checkout location. Use `--worker-config` to select a separate approved GoalTagger configuration when it and its model files are inside the model source checkout. The bundle can make its configured artifact paths portable. The resident worker uses the configuration selected in its service environment. [GoalTagger worker configuration](MODELS-RUNBOOK.md#google-ads-models)

## Pack, upload, install, and verify

Set `$Target` to the existing administrative SSH alias. Run this PowerShell block as a single invocation after the preview. It uses a fresh upload directory under the SSH account's home and takes the manifest SHA-256 from the PC. Keep the terminal open for the VM's `sudo` prompt.

```powershell
$Target = Read-Host 'Administrative SSH alias for the VM'
& {
    node scripts/models/pack-store.mjs --root $ModelSource --out $Bundle --write
    if ($LASTEXITCODE -ne 0) { throw 'Packing failed' }
    $ManifestSha = (Get-FileHash -LiteralPath "$Bundle/manifest.json" -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()

    ssh $Target ('umask 077 && install -d -m 0700 -- "$HOME/model-uploads" && test ! -e "$HOME/model-uploads/{0}" && test ! -L "$HOME/model-uploads/{0}"' -f $Name)
    if ($LASTEXITCODE -ne 0) { throw 'Upload destination is unavailable' }
    scp -r "./$Bundle" "${Target}:model-uploads/$Name"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }

    $Remote = 'sudo bash /opt/mohassan/app/scripts/cloud-linux/install-model-store.sh install "$HOME/model-uploads/{0}" --manifest-sha256 {1} --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1 && sudo -u mohassan -- /usr/local/bin/npm --prefix /opt/mohassan/app run models:verify-store -- --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1'
    ssh -t $Target ($Remote -f $Name, $ManifestSha)
    if ($LASTEXITCODE -ne 0) { throw 'Installation or verification failed' }
}
```

On a Linux PC, run these from the tools checkout and review the preview before running the second block. The second block completes the upload, installation, and verification in one invocation.

```bash
read -r -p 'Path to the existing model source checkout: ' model_source
read -r -p 'Administrative SSH alias for the VM: ' target
name="model-store-$(date -u +%Y%m%dT%H%M%SZ)"
bundle="artifacts/$name"
mkdir -p -- artifacts
node scripts/models/pack-store.mjs --root "$model_source" --out "$bundle"
```

```bash
node scripts/models/pack-store.mjs --root "$model_source" --out "$bundle" --write &&
  manifest_sha=$(sha256sum -- "$bundle/manifest.json") && manifest_sha=${manifest_sha%% *} &&
  ssh "$target" 'umask 077 && install -d -m 0700 -- "$HOME/model-uploads"' &&
  ssh "$target" "test ! -e 'model-uploads/$name' && test ! -L 'model-uploads/$name'" &&
  scp -r -- "./$bundle" "${target}:model-uploads/$name" &&
  ssh -t "$target" "sudo bash /opt/mohassan/app/scripts/cloud-linux/install-model-store.sh install \"\$HOME/model-uploads/$name\" --manifest-sha256 $manifest_sha --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1 && sudo -u mohassan -- /usr/local/bin/npm --prefix /opt/mohassan/app run models:verify-store -- --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1"
```

For a separate manual installation, run the following in the VM administrative shell after uploading. Enter the directory name and the digest recorded on the PC.

```bash
read -r -p 'Uploaded bundle directory name: ' name
read -r -p 'Manifest SHA-256 from the PC: ' manifest_sha
sudo bash /opt/mohassan/app/scripts/cloud-linux/install-model-store.sh install "$HOME/model-uploads/$name" \
  --manifest-sha256 "$manifest_sha" --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1 &&
  sudo -u mohassan -- /usr/local/bin/npm --prefix /opt/mohassan/app run models:verify-store -- \
    --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1
```

The verifier reports each registered model and its files as present, absent, hash mismatch, or unpinned. An unpinned file still passed the upload's SHA-256 check if the installer succeeded. Add `--silent` to npm and `--json` to the verifier for machine-readable output. Add `--strict` if absent catalog entries should fail a check. A missing store directory or hash mismatch fails in either mode. Run under the service identity so file access is checked from its perspective. The verifier checks the registry layout in the selected store and the configured OCR export directory. The service's other path overrides and activation switches still determine runtime availability. The owner Models page describes which installed models have runners or are enabled. The service stays online when adding files to the store. A resident model can keep using its loaded weights. The app loads OCR weights at startup, so use a planned restart to activate new OCR weights in an already-running app. [Models page and runners](MODEL-COUNCIL.md#models-page) · [OCR configuration](MODELS-RUNBOOK.md#ocr-readers)

## Disk and time estimates

Read the exact payload size from the generated manifest. The following estimates the PC bundle bytes and the upload time from a measured effective transfer rate in decimal Mbit/s. Use measured sustained rates from the PC and VM to estimate the local copy and verification passes.

```powershell
$ManifestPath = "$Bundle/manifest.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$UploadBytes = $Manifest.totalBytes + (Get-Item -LiteralPath $ManifestPath).Length
$Mbps = [double](Read-Host 'Measured effective upload rate in Mbit/s')
$MiBps = [double](Read-Host 'Measured local read or copy rate in MiB/s')
[pscustomobject]@{
    PayloadBytes = $Manifest.totalBytes
    BundleBytes = $UploadBytes
    EstimatedUploadSeconds = [math]::Ceiling(8 * $UploadBytes / ($Mbps * 1e6))
    EstimatedSecondsPerPayloadPass = [math]::Ceiling($Manifest.totalBytes / ($MiBps * 1MB))
}
```

Allow for a local pack pass and for the VM's installation and verification passes. Verification can also read retained artifacts. Include filesystem allocation and directory overhead. On the VM the upload takes the bundle size and staging takes the incoming payload plus the live files being carried forward. As a conservative byte estimate, add the entire current store size to `PayloadBytes` for staging. Add the upload and stage estimates together when the upload and store share a filesystem. Use `df` to check free space and `du` to measure existing stores. Previously retained generations already consume disk space, and the installer keeps them after each run.

```bash
sudo df -B1 -- "$HOME/model-uploads" /var/lib/mohassan
sudo du --apparent-size --summarize --block-size=1 -- /var/lib/mohassan/models /var/lib/mohassan/ocr-v1
```

## Roll back

Record the previous-store paths printed when the installer replaces an existing store. Run these commands using the exact path printed for each root you want to restore. If the main store includes OCR, the first rollback restores both.

```bash
read -r -p 'Previous models path printed by installer: ' previous_models
sudo bash /opt/mohassan/app/scripts/cloud-linux/install-model-store.sh rollback "$previous_models" --store /var/lib/mohassan/models

read -r -p 'Previous OCR path printed by installer: ' previous_ocr
sudo bash /opt/mohassan/app/scripts/cloud-linux/install-model-store.sh rollback "$previous_ocr" --store /var/lib/mohassan/ocr-v1

sudo -u mohassan -- /usr/local/bin/npm --prefix /opt/mohassan/app run models:verify-store -- \
  --store /var/lib/mohassan/models --ocr-dir /var/lib/mohassan/ocr-v1
```

Each rollback atomically exchanges the selected backup with its live path. The selected backup path then holds the displaced generation. When OCR has its own store, it and the main store publish separately. The installer prepares both before publishing either and restores the first if the second swap fails during the run. After a host interruption during publication, verify both paths. If the running app has already loaded the replaced OCR export, activate the restored files with the normal planned service restart. [Linux cutover and verification](../scripts/cloud-linux/README.md#cutover-and-verification)
