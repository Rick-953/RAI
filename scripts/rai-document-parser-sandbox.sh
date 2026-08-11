#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    echo "document_parser_launcher_arguments_invalid" >&2
    exit 64
fi

profile=$1
kind=$2

case "$profile" in
    beta)
        app_root=/opt/rai/apps/beta
        ;;
    formal)
        app_root=/opt/rai/apps/formal
        ;;
    *)
        echo "document_parser_launcher_profile_blocked" >&2
        exit 64
        ;;
esac

case "$kind" in
    docx|xlsx|pptx|csv)
        ;;
    *)
        echo "document_parser_launcher_kind_blocked" >&2
        exit 64
        ;;
esac

node_root=/opt/rai/runtime/node-v24.16.0
node_bin=$node_root/bin/node
worker_path=$app_root/workers/document-parser-worker.js
modules_path=$app_root/node_modules

for required_path in "$node_bin" "$worker_path" "$modules_path" /usr/bin/bwrap /usr/bin/prlimit /lib /lib64; do
    if [ ! -e "$required_path" ]; then
        echo "document_parser_launcher_dependency_missing" >&2
        exit 69
    fi
done

exec /usr/bin/prlimit \
    --as=2147483648 \
    --cpu=10 \
    --nproc=64 \
    --nofile=64 \
    --fsize=1048576 \
    --core=0 \
    -- \
    /usr/bin/bwrap \
        --unshare-all \
        --die-with-parent \
        --new-session \
        --clearenv \
        --setenv PATH "$node_root/bin" \
        --setenv HOME /tmp \
        --setenv NODE_ENV production \
        --setenv LANG C.UTF-8 \
        --setenv LC_ALL C.UTF-8 \
        --setenv TZ UTC \
        --dir /app \
        --dir /app/workers \
        --ro-bind "$node_root" "$node_root" \
        --ro-bind /lib /lib \
        --ro-bind /lib64 /lib64 \
        --ro-bind "$modules_path" /app/node_modules \
        --ro-bind "$worker_path" /app/workers/document-parser-worker.js \
        --dir /proc \
        --dev /dev \
        --tmpfs /tmp \
        --chdir /app \
        --uid 65534 \
        --gid 65534 \
        --cap-drop ALL \
        -- "$node_bin" --max-old-space-size=144 /app/workers/document-parser-worker.js "$kind"
