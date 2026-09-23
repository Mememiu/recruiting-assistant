import Foundation
import ImageIO
import Vision

guard CommandLine.arguments.count == 2,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("无法读取简历图片\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> (CGFloat, CGFloat, String)? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        return (observation.boundingBox.midY, observation.boundingBox.minX, text)
    }.sorted { left, right in
        if abs(left.0 - right.0) > 0.012 { return left.0 > right.0 }
        return left.1 < right.1
    }
    for line in lines { print(line.2) }
} catch {
    fputs("简历文字识别失败：\(error)\n", stderr)
    exit(1)
}
