package io.github.localdesktop;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileReader;
import java.io.IOException;

/**
 * Serves non-text items (like images) copied on the Linux desktop to Android apps pasting from the
 * clipboard. Android's ClipboardManager cannot hold large binary payloads directly; instead it
 * holds a {@code content://} URI backed by this provider, and grants temporary read permission to
 * whichever app pastes.
 */
public final class ClipboardProvider extends ContentProvider {
    private static final String DIR = "arch/tmp/localdesktop-clipboard";
    private static final String DATA_FILE = "out";
    private static final String MIME_FILE = "out.mime";

    @Override
    public boolean onCreate() {
        return true;
    }

    private File clipDir() {
        if (getContext() == null) {
            return null;
        }
        return new File(getContext().getFilesDir(), DIR);
    }

    private File dataFile() {
        File dir = clipDir();
        return dir != null ? new File(dir, DATA_FILE) : null;
    }

    private String readMime() {
        File dir = clipDir();
        if (dir == null) {
            return null;
        }
        File mimeFile = new File(dir, MIME_FILE);
        if (!mimeFile.isFile()) {
            return null;
        }
        try (BufferedReader reader = new BufferedReader(new FileReader(mimeFile))) {
            String line = reader.readLine();
            if (line != null) {
                line = line.trim();
                if (!line.isEmpty()) {
                    return line;
                }
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    @Override
    public String getType(Uri uri) {
        String mime = readMime();
        return mime != null ? mime : "application/octet-stream";
    }

    @Override
    public String[] getStreamTypes(Uri uri, String mimeTypeFilter) {
        String mime = readMime();
        return mime != null ? new String[]{mime} : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) {
            throw new SecurityException("ClipboardProvider is read-only");
        }
        File file = dataFile();
        if (file == null || !file.isFile()) {
            throw new FileNotFoundException("No clipboard item");
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(
            Uri uri,
            String[] projection,
            String selection,
            String[] selectionArgs,
            String sortOrder) {
        File file = dataFile();
        if (file == null || !file.isFile()) {
            return null;
        }
        String[] columns = projection != null
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        String name = fileNameForMime(readMime(), uri);
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) {
                row[i] = name;
            } else if (OpenableColumns.SIZE.equals(columns[i])) {
                row[i] = file.length();
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    private static String fileNameForMime(String mime, Uri uri) {
        String last = uri != null ? uri.getLastPathSegment() : null;
        if (last != null && last.contains(".")) {
            return last;
        }
        if ("image/png".equals(mime)) {
            return "clipboard.png";
        }
        if ("image/jpeg".equals(mime)) {
            return "clipboard.jpg";
        }
        if ("image/webp".equals(mime)) {
            return "clipboard.webp";
        }
        if ("image/gif".equals(mime)) {
            return "clipboard.gif";
        }
        if ("image/bmp".equals(mime)) {
            return "clipboard.bmp";
        }
        if ("image/svg+xml".equals(mime)) {
            return "clipboard.svg";
        }
        return "clipboard";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
