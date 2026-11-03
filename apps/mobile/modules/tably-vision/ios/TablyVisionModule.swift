import ExpoModulesCore
import Vision
import UIKit

struct OcrLineRecord: Record {
  @Field var text: String = ""
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var w: Double = 0
  @Field var h: Double = 0
  @Field var confidence: Double = 0
}

private struct Pass {
  var lines: [OcrLineRecord]
  var score: Double
}

public class TablyVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TablyVision")

    // Recognizes text in the image at `uri` (file:// path). Tries the other three
    // orientations only when the upright pass finds little text, to handle rotated photos.
    AsyncFunction("recognizeText") { (uri: String) -> [OcrLineRecord] in
      guard let url = URL(string: uri), let data = try? Data(contentsOf: url),
            let image = UIImage(data: data), let cg = image.cgImage else {
        throw Exception(name: "ERR_IMAGE", description: "Could not load the image.")
      }
      let base = TablyVisionModule.orientation(image.imageOrientation)
      var best = try TablyVisionModule.run(cg, base)
      if best.lines.count < 4 || best.score / Double(max(best.lines.count, 1)) < 0.5 {
        for extra in [CGImagePropertyOrientation.right, .down, .left] {
          let o = TablyVisionModule.rotate(base, extra)
          let pass = try TablyVisionModule.run(cg, o)
          if pass.score > best.score { best = pass }
        }
      }
      return best.lines
    }
  }

  private static func run(_ cg: CGImage, _ orientation: CGImagePropertyOrientation) throws -> Pass {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Language correction tends to "fix" digits and product names into dictionary words.
    request.usesLanguageCorrection = false
    if #available(iOS 16.0, *) {
      request.automaticallyDetectsLanguage = true
      request.recognitionLanguages = ["en-US", "ar-SA"]
    }
    let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:])
    try handler.perform([request])

    var lines: [OcrLineRecord] = []
    var score = 0.0
    for obs in (request.results ?? []) {
      guard let top = obs.topCandidates(1).first else { continue }
      let box = obs.boundingBox // normalized, origin bottom-left
      var r = OcrLineRecord()
      r.text = top.string
      r.x = Double(box.minX)
      r.y = Double(1.0 - box.maxY) // convert to top-left origin
      r.w = Double(box.width)
      r.h = Double(box.height)
      r.confidence = Double(top.confidence)
      lines.append(r)
      score += Double(top.confidence) * Double(top.string.count)
    }
    return Pass(lines: lines, score: score)
  }

  private static func orientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch o {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }

  /// Compose an extra clockwise-style rotation onto the image's own orientation.
  private static func rotate(_ base: CGImagePropertyOrientation, _ extra: CGImagePropertyOrientation) -> CGImagePropertyOrientation {
    let order: [CGImagePropertyOrientation] = [.up, .right, .down, .left]
    guard let b = order.firstIndex(of: base), let e = order.firstIndex(of: extra) else { return extra }
    return order[(b + e) % 4]
  }
}
