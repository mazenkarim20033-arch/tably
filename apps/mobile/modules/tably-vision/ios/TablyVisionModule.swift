import ExpoModulesCore
import Vision
import UIKit

/// One word inside an observation, with its own box (top-left origin, normalized to the upright image).
struct OcrWordRecord: Record {
  @Field var text: String = ""
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var w: Double = 0
  @Field var h: Double = 0
}

struct OcrLineRecord: Record {
  @Field var text: String = ""
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var w: Double = 0
  @Field var h: Double = 0
  @Field var confidence: Double = 0
  // Runner-up readings of the same text (Vision can read 60.00 as 80.00); the parser uses them to explain mismatches.
  @Field var alternates: [String] = []
  @Field var alternateConfidences: [Double] = []
  // The observation's true corners: top-left, top-right, bottom-right, bottom-left as x,y pairs (top-left origin).
  // Unlike the axis-aligned box, they give the real angle of a tilted line.
  @Field var quad: [Double] = []
  // Each whitespace-separated word with its own box, so a price inside a merged line still has a position.
  @Field var words: [OcrWordRecord] = []
}

struct OcrResultRecord: Record {
  @Field var lines: [OcrLineRecord] = []
  /// Pixel size of the image as recognized (after orientation), so normalized x and y can be compared as lengths.
  @Field var width: Double = 0
  @Field var height: Double = 0
}

private struct Pass {
  var lines: [OcrLineRecord]
  var score: Double
  var orientation: CGImagePropertyOrientation
}

public class TablyVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TablyVision")

    // Recognizes text in the image at `uri` (file:// path). Tries the other three
    // orientations only when the upright pass finds little text, to handle rotated photos.
    AsyncFunction("recognizeText") { (uri: String) -> OcrResultRecord in
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
      var result = OcrResultRecord()
      result.lines = best.lines
      let sideways: Set<CGImagePropertyOrientation> = [.left, .right, .leftMirrored, .rightMirrored]
      let swap = sideways.contains(best.orientation)
      result.width = Double(swap ? cg.height : cg.width)
      result.height = Double(swap ? cg.width : cg.height)
      return result
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
      let candidates = obs.topCandidates(5)
      guard let top = candidates.first else { continue }
      let box = obs.boundingBox // normalized, origin bottom-left
      var r = OcrLineRecord()
      r.text = top.string
      let others = candidates.dropFirst().filter { $0.string != top.string }
      r.alternates = others.map { $0.string }
      r.alternateConfidences = others.map { Double($0.confidence) }
      r.x = Double(box.minX)
      r.y = Double(1.0 - box.maxY) // convert to top-left origin
      r.w = Double(box.width)
      r.h = Double(box.height)
      r.confidence = Double(top.confidence)
      r.quad = [obs.topLeft, obs.topRight, obs.bottomRight, obs.bottomLeft].flatMap { [Double($0.x), Double(1.0 - $0.y)] }
      r.words = TablyVisionModule.words(of: top)
      lines.append(r)
      score += Double(top.confidence) * Double(top.string.count)
    }
    return Pass(lines: lines, score: score, orientation: orientation)
  }

  /// Boxes for each whitespace-separated word of a recognized string.
  private static func words(of text: VNRecognizedText) -> [OcrWordRecord] {
    let s = text.string
    var out: [OcrWordRecord] = []
    var i = s.startIndex
    while i < s.endIndex {
      while i < s.endIndex && s[i].isWhitespace { i = s.index(after: i) }
      if i >= s.endIndex { break }
      var j = i
      while j < s.endIndex && !s[j].isWhitespace { j = s.index(after: j) }
      if let rect = try? text.boundingBox(for: i..<j)?.boundingBox {
        var w = OcrWordRecord()
        w.text = String(s[i..<j])
        w.x = Double(rect.minX)
        w.y = Double(1.0 - rect.maxY)
        w.w = Double(rect.width)
        w.h = Double(rect.height)
        out.append(w)
      }
      i = j
    }
    return out
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
