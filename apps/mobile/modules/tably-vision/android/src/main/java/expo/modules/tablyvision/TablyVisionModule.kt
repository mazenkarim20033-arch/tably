package expo.modules.tablyvision

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * On-device receipt OCR for Android with Google ML Kit. Returns the same shape as the iPhone module: lines with a box
 * and corners (normalized to the upright image, top-left origin), a confidence, and each word with its own box.
 * ML Kit gives no runner-up readings, so `alternates` is always empty (the engine treats them as optional).
 */
class TablyVisionModule : Module() {
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  override fun definition() = ModuleDefinition {
    Name("TablyVision")

    AsyncFunction("recognizeText") { uri: String, promise: Promise ->
      try {
        val context = appContext.reactContext ?: throw IllegalStateException("No context")
        val upright = loadUpright(context, Uri.parse(uri)) ?: throw IllegalStateException("Could not load the image.")
        // Photos of a receipt are sometimes sideways: when the upright pass finds little text, try the other three turns.
        var best = read(upright)
        var bestBitmap = upright
        if (best.lineCount < 4 || best.score / maxOf(best.lineCount, 1) < 0.5) {
          for (degrees in intArrayOf(90, 270, 180)) {
            val turned = rotate(upright, degrees)
            val pass = read(turned)
            if (pass.score > best.score) {
              best = pass
              bestBitmap = turned
            }
          }
        }
        val w = bestBitmap.width.toDouble()
        val h = bestBitmap.height.toDouble()
        val result = mapOf(
          "lines" to best.text.textBlocks.flatMap { it.lines }.map { lineMap(it, w, h) },
          "width" to w,
          "height" to h,
        )
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("ERR_OCR", e.message ?: "Text recognition failed.", e)
      }
    }
  }

  private class Pass(val text: Text, val lineCount: Int, val score: Double)

  private fun read(bitmap: Bitmap): Pass {
    val text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)))
    val lines = text.textBlocks.flatMap { it.lines }
    // More recognized characters, weighted by how sure the reader is.
    val score = lines.sumOf { it.text.length * (it.confidence.toDouble().takeIf { c -> c > 0 } ?: 0.8) }
    return Pass(text, lines.size, score)
  }

  private fun lineMap(line: Text.Line, w: Double, h: Double): Map<String, Any> {
    val box = line.boundingBox
    val x = (box?.left ?: 0) / w
    val y = (box?.top ?: 0) / h
    val bw = (box?.width() ?: 0) / w
    val bh = (box?.height() ?: 0) / h
    val corners = line.cornerPoints
    val quad = if (corners != null && corners.size == 4) {
      corners.flatMap { listOf(it.x / w, it.y / h) }
    } else {
      listOf(x, y, x + bw, y, x + bw, y + bh, x, y + bh)
    }
    return mapOf(
      "text" to line.text,
      "x" to x, "y" to y, "w" to bw, "h" to bh,
      "confidence" to (line.confidence.toDouble().takeIf { it > 0 } ?: 0.8),
      "alternates" to emptyList<String>(),
      "alternateConfidences" to emptyList<Double>(),
      "quad" to quad,
      "words" to line.elements.map { el ->
        val b = el.boundingBox
        mapOf(
          "text" to el.text,
          "x" to (b?.left ?: 0) / w, "y" to (b?.top ?: 0) / h,
          "w" to (b?.width() ?: 0) / w, "h" to (b?.height() ?: 0) / h,
        )
      },
    )
  }

  /** The photo as it looks to a person: decoded at a sensible size and turned by its EXIF orientation. */
  private fun loadUpright(context: android.content.Context, uri: Uri): Bitmap? {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 3200) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
    val orientation = resolver.openInputStream(uri)?.use {
      ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } ?: ExifInterface.ORIENTATION_NORMAL
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
      else -> return decoded
    }
    return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
  }

  private fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
    val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  }
}
