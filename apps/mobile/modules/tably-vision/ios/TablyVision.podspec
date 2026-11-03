Pod::Spec.new do |s|
  s.name           = 'TablyVision'
  s.version        = '1.0.0'
  s.summary        = 'On-device receipt OCR using Apple Vision'
  s.description    = 'Wraps VNRecognizeTextRequest and returns recognized lines with bounding boxes.'
  s.author         = 'TABLY'
  s.homepage       = 'https://tably.app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
